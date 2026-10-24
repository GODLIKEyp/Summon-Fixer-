import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { validateTimeoutMs } from './deadline.js';

export const TERMINATION_GRACE_MS = 250;
export const TERMINATION_WAIT_MS = 750;
export const MAX_VERIFICATION_OUTPUT_BYTES = 1024 * 1024;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Children must be spawned detached on POSIX so the group belongs to this job. */
export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  const group = process.platform !== 'win32' && child.pid !== undefined;
  const alive = () => {
    if (!group) return child.exitCode === null && child.signalCode === null;
    try { process.kill(-child.pid!, 0); return true; } catch { return false; }
  };
  const signal = (value: NodeJS.Signals) => {
    try {
      if (group) process.kill(-child.pid!, value);
      else if (child.exitCode === null && child.signalCode === null) child.kill(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  if (!alive()) return;
  signal('SIGTERM');
  const graceEnd = Date.now() + TERMINATION_GRACE_MS;
  while (alive() && Date.now() < graceEnd) await pause(20);
  if (alive()) signal('SIGKILL');
  const waitEnd = Date.now() + TERMINATION_WAIT_MS;
  while (child.exitCode === null && child.signalCode === null && Date.now() < waitEnd) await pause(20);
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error('Process did not confirm exit after bounded termination');
  }
  // POSIX group signaling includes descendants that remain in the group. It
  // cannot contain descendants that deliberately create a new session/group.
}

export class ManagedProcessError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ManagedProcessError';
  }
}

export interface ProcessResult { stdout: string; exitCode: number | null }

/** No stderr, command arguments or environment values are included in errors. */
export async function runManagedProcess(options: {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  input?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  onStdout?: (text: string) => void;
  onStage?: (stage: 'spawned' | 'first_output' | 'exited') => void;
}): Promise<ProcessResult> {
  validateTimeoutMs(options.timeoutMs);
  if (options.signal?.aborted) throw new ManagedProcessError('ABORTED', 'Process cancelled');
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd, env: options.env, shell: options.shell,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  };
  let child: ChildProcess;
  try { child = spawn(options.command, options.args ?? [], spawnOptions); }
  catch { throw new ManagedProcessError('SPAWN_FAILED', 'Process could not be started'); }

  return new Promise<ProcessResult>((resolve, reject) => {
    let finishing = false;
    let stdout = '';
    let bytes = 0;
    let firstOutput = false;
    const decoder = new StringDecoder('utf8');
    const report = (stage: 'spawned' | 'first_output' | 'exited') => {
      try { options.onStage?.(stage); } catch { /* Diagnostics cannot alter execution. */ }
    };
    const finish = async (error?: ManagedProcessError, exitCode: number | null = null) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      let cleanupError: ManagedProcessError | undefined;
      try { await terminateProcessTree(child); }
      catch { cleanupError = new ManagedProcessError('TERMINATION_FAILED', 'Process cleanup could not confirm exit'); }
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      report('exited');
      if (cleanupError || error) reject(cleanupError ?? error);
      else resolve({ stdout: stdout + decoder.end(), exitCode });
    };
    const onAbort = () => { void finish(new ManagedProcessError('ABORTED', 'Process cancelled')); };
    const timer = setTimeout(() => {
      void finish(new ManagedProcessError('TIMEOUT', `Process timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    const onChunk = (chunk: Buffer, isStdout: boolean) => {
      if (finishing) return;
      bytes += chunk.length;
      if (!firstOutput) { firstOutput = true; report('first_output'); }
      if (bytes > options.maxOutputBytes) {
        void finish(new ManagedProcessError('OUTPUT_TOO_LARGE', `Process exceeded maximum output limit of ${options.maxOutputBytes} bytes`));
        return;
      }
      if (isStdout) {
        const text = decoder.write(chunk);
        stdout += text;
        try { options.onStdout?.(text); } catch { /* Observers cannot affect execution. */ }
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => onChunk(chunk, true));
    child.stderr?.on('data', (chunk: Buffer) => onChunk(chunk, false));
    child.once('spawn', () => report('spawned'));
    child.once('error', () => { void finish(new ManagedProcessError('SPAWN_FAILED', 'Process could not be started')); });
    child.once('close', (code) => { void finish(undefined, code); });
    child.stdin?.on('error', () => { /* EPIPE is resolved by the exit/error handler. */ });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    else child.stdin?.end(options.input);
  });
}
