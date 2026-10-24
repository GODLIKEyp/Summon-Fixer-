import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, readdirSync, renameSync, symlinkSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { TaskExecutor } from '../executor.js';
import { RealCodexRunner } from '../codex/real_runner.js';
import { startEngine, type EngineInstance } from '../engine.js';
import { runManagedProcess } from '../process.js';
import * as writer from '../safe-write.js';
import type { CodexRunnerInterface, CodexDiagnostic } from '../codex/types.js';

let root: string;
const outsideRoots: string[] = [];
let engine: EngineInstance | undefined;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'summon-release-')); });
afterEach(async () => { vi.restoreAllMocks(); for (const dir of outsideRoots.splice(0)) rmSync(dir, { recursive: true, force: true }); await engine?.close(); engine = undefined; rmSync(root, { recursive: true, force: true }); });

const output = { summary: 'fixture', edits: [{ path: 'src/a.ts', changeType: 'update' as const,
  oldContent: 'const value = 1;', newContent: 'const value = 2;' }] };
const requestBody = (mode: 'manual' | 'plan' = 'manual') => ({ requestId: 'fixture', prompt: 'fixture',
  requestedMode: mode, priority: 'normal' as const, createdAt: new Date().toISOString() });
const approval = (task: Awaited<ReturnType<TaskExecutor['createTask']>>) => ({ taskId: task.taskId,
  taskVersion: task.version, proposalDigest: task.proposal!.proposalDigest!, decision: 'approved' as const,
  respondedAt: new Date().toISOString() });
async function fixture(edits = output.edits, mode: 'manual' | 'plan' = 'manual', content = 'const value = 1;\n') {
  mkdirSync(join(root, 'src'), { recursive: true });
  const path = join(root, 'src/a.ts');
  writeFileSync(path, content, { mode: 0o600 });
  const executor = new TaskExecutor({ workspaceRoot: root, runner: { mode: 'fake', propose: async () => ({ ...output, edits }) } });
  const task = await executor.createTask({ request: requestBody(mode), sourceHints: [{ filePath: 'src/a.ts' }] });
  await new Promise(setImmediate);
  return { executor, task, path };
}

describe('Fail-closed application boundary', () => {
  it.each([0o600, 0o755])('refuses application without altering content, mode %i, inode or staging entries', async (mode) => {
    const { executor, task, path } = await fixture();
    chmodSync(path, mode);
    const before = statSync(path);
    await expect(executor.applyApproval(task.taskId, approval(task))).rejects.toMatchObject({ code: 'SAFE_WRITE_UNAVAILABLE' });
    expect(readFileSync(path, 'utf8')).toBe('const value = 1;\n');
    expect(statSync(path).ino).toBe(before.ino);
    expect(statSync(path).mode).toBe(before.mode);
    expect(readdirSync(join(root, 'src'))).toEqual(['a.ts']);
    expect(task.application).toEqual({ status: 'not_applied', appliedEditsCount: 0 });
    expect(task.error?.code).toBe('SAFE_WRITE_UNAVAILABLE');
    await expect(executor.applyApproval(task.taskId, approval(task))).rejects.toMatchObject({ code: 'INVALID_TASK_STATUS' });
  });

  it.each(['writer', 'file-replacement', 'parent-swap'])('preserves a %s mutation at the final writer boundary', async (kind) => {
    const { executor, task, path } = await fixture();
    const original = writer.replaceFileSafely;
    const outside = mkdtempSync(join(tmpdir(), 'summon-outside-'));
    outsideRoots.push(outside);
    writeFileSync(join(outside, 'a.ts'), 'outside sentinel');
    // Mutation is injected after executor preconditions, immediately before
    // the real production boundary. The boundary must never open a write path.
    vi.spyOn(writer, 'replaceFileSafely').mockImplementation((target, content) => {
      if (kind === 'writer') writeFileSync(path, 'concurrent writer');
      if (kind === 'file-replacement') {
        renameSync(path, path + '.old'); writeFileSync(path, 'concurrent replacement');
      }
      if (kind === 'parent-swap') {
        renameSync(join(root, 'src'), join(root, 'original-src'));
        symlinkSync(outside, join(root, 'src'));
      }
      original(target, content);
    });
    await expect(executor.applyApproval(task.taskId, approval(task))).rejects.toMatchObject({ code: 'SAFE_WRITE_UNAVAILABLE' });
    expect(readFileSync(join(outside, 'a.ts'), 'utf8')).toBe('outside sentinel');
    if (kind !== 'parent-swap') expect(readFileSync(path, 'utf8')).toContain('concurrent');
    expect(readdirSync(outside)).toEqual(['a.ts']);
  });

  it('keeps Plan Only read-only without entering the writer', async () => {
    const spy = vi.spyOn(writer, 'replaceFileSafely');
    const { executor, task, path } = await fixture(undefined, 'plan');
    expect(task.status).toBe('completed');
    expect(task.completion?.type).toBe('read_only');
    expect(spy).not.toHaveBeenCalled();
    await expect(executor.applyApproval(task.taskId, approval(task))).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe('const value = 1;\n');
  });

  it('reports applied data and verification failure with a simulated successful storage boundary', async () => {
    // A test-only writer in an exclusively owned fixture exercises future
    // post-write state handling. It does not assert production write support.
    vi.spyOn(writer, 'replaceFileSafely').mockImplementation((path, content) => writeFileSync(path, content));
    const { executor, task, path } = await fixture([{ ...output.edits[0], newContent: 'const = ;' }]);
    await expect(executor.applyApproval(task.taskId, approval(task))).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
    expect(readFileSync(path, 'utf8')).toContain('const = ;');
    expect(task.status).toBe('failed');
    expect(task.application).toEqual({ status: 'applied', appliedEditsCount: 1 });
    expect(task.verification?.status).toBe('failed');
    expect(task.error?.code).toBe('VERIFICATION_FAILED');
    expect(task.edits[0].status).toBe('applied');
  });
});

describe('Snippet uniqueness and deadlines', () => {
  it('rejects overlapping snippets during planning', async () => {
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/a.ts'), '// aaa');
    const executor = new TaskExecutor({ workspaceRoot: root, runner: { mode: 'fake', propose: async () => ({
      summary: 'fixture', edits: [{ ...output.edits[0], oldContent: 'aa', newContent: 'bb' }],
    }) } });
    const task = await executor.createTask({ request: requestBody(), sourceHints: [{ filePath: 'src/a.ts' }] });
    await new Promise(setImmediate);
    expect(task.status).toBe('failed');
    expect(task.error?.message).toContain('ambiguous');
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('// aaa');
  });

  it('rechecks overlapping ambiguity at application, even for an internally replaced proposal', async () => {
    const { executor, task, path } = await fixture([{ ...output.edits[0], oldContent: 'aaa', newContent: 'bbb' }], 'manual', '// aaa');
    // Exercise apply independently of planning without changing the disk/hash.
    task.proposal!.edits[0].oldContent = 'aa';
    await expect(executor.applyApproval(task.taskId, approval(task))).rejects.toMatchObject({ code: 'AMBIGUOUS_SNIPPET' });
    expect(readFileSync(path, 'utf8')).toBe('// aaa');
  });

  it('propagates a deadline and cancels a runner that never resolves', async () => {
    let input: Parameters<CodexRunnerInterface['propose']>[0] | undefined;
    const executor = new TaskExecutor({ workspaceRoot: root, proposalTimeoutMs: 10,
      runner: { mode: 'fake', propose: (value) => { input = value; return new Promise(() => {}); } } });
    const task = await executor.createTask({ request: requestBody() });
    await vi.waitFor(() => expect(task.status).toBe('failed'), { timeout: 2000 });
    expect(input?.timeoutMs).toBe(10);
    expect(input?.signal?.aborted).toBe(true);
    expect(task.error).toMatchObject({ code: 'TIMEOUT', category: 'timeout' });
    await executor.close();
  });

  it('shutdown aborts active work and refuses new jobs', async () => {
    let signal: AbortSignal | undefined;
    const executor = new TaskExecutor({ workspaceRoot: root, runner: { mode: 'fake', propose: (input) => {
      signal = input.signal; return new Promise((_, reject) => input.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    } } });
    await executor.createTask({ request: requestBody() });
    await executor.close();
    expect(signal?.aborted).toBe(true);
    await expect(executor.createTask({ request: requestBody() })).rejects.toMatchObject({ code: 'ENGINE_STOPPING' });
  });
});

const message = (text: string) => ({ type: 'item.completed', item: { type: 'agent_message', text } });
const valid = message(JSON.stringify(output));
function executable(code: string): string {
  const path = join(root, 'codex-fixture');
  writeFileSync(path, `#!${process.execPath}\n${code}\n`, { mode: 0o700 });
  return path;
}

describe('Actual local subprocess event handling (no model)', () => {
  it.each([
    ['turn.failed', { type: 'turn.failed', error: { message: 'DO_NOT_LEAK_SECRET' } }],
    ['malformed JSON', message('not json')], ['invalid schema', message('{"bad":true}')],
  ])('rejects a valid proposal followed by %s', async (_, terminal) => {
    const path = executable(`console.log(${JSON.stringify(JSON.stringify(valid))}); process.stdout.write(${JSON.stringify(JSON.stringify(terminal))});`);
    await expect(new RealCodexRunner(path).propose({ prompt: 'fixture', workspaceRoot: root }))
      .rejects.toThrow(/failed|schema/);
  });

  it('accepts a slow valid result within a configured deadline and emits sanitized live stages', async () => {
    const diagnostics: CodexDiagnostic[] = [];
    const path = executable(`console.log(JSON.stringify({type:'thread.started'})); setTimeout(() => console.log(${JSON.stringify(JSON.stringify(valid))}), 80);`);
    const result = await new RealCodexRunner(path).propose({ prompt: 'PRIVATE_PROMPT', workspaceRoot: root,
      timeoutMs: 1500, onDiagnostic: (value) => diagnostics.push(value) });
    expect(result.summary).toBe('fixture');
    expect(diagnostics.map((value) => value.stage)).toEqual(expect.arrayContaining(['spawned', 'first_output', 'first_event', 'proposal_received', 'exited', 'completed']));
    expect(JSON.stringify(diagnostics)).not.toMatch(/PRIVATE_PROMPT|output.json|DO_NOT_LEAK_SECRET/);
    expect(diagnostics.findIndex((value) => value.stage === 'first_event')).toBeLessThan(diagnostics.findIndex((value) => value.stage === 'exited'));
  });

  it('cleans the private schema directory and keeps prompt out of argv on failure', async () => {
    const record = join(root, 'record.json');
    const path = executable(`require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv)); process.stderr.write('DO_NOT_LEAK_SECRET'); process.exit(7);`);
    await expect(new RealCodexRunner(path).propose({ prompt: 'PRIVATE_PROMPT', workspaceRoot: root })).rejects.toThrow('Codex process exited with code 7');
    const args = JSON.parse(readFileSync(record, 'utf8')) as string[];
    expect(args.join(' ')).not.toContain('PRIVATE_PROMPT');
    expect(existsSync(args[args.indexOf('--output-schema') + 1])).toBe(false);
  });

  it('bounds output from verification subprocesses', async () => {
    await expect(runManagedProcess({ command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000)"],
      cwd: root, timeoutMs: 1000, maxOutputBytes: 100 })).rejects.toMatchObject({ code: 'OUTPUT_TOO_LARGE' });
  });

  it('terminates a SIGTERM-ignoring process and its group descendant at deadline', async () => {
    if (process.platform === 'win32') throw new Error('POSIX descendant regression requires a POSIX test host');
    const marker = join(root, 'descendant');
    const ready = join(root, 'ready');
    const code = `process.on('SIGTERM',()=>{});require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify("process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(" + JSON.stringify(ready) + ",'ready');setTimeout(()=>require('node:fs').writeFileSync(" + JSON.stringify(marker) + ",'escaped'),1500);setInterval(()=>{},1000)")}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    await expect(runManagedProcess({ command: process.execPath, args: ['-e', code], cwd: root,
      timeoutMs: 600, maxOutputBytes: 100 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(existsSync(ready)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1550));
    expect(existsSync(marker)).toBe(false);
  });
});

describe('Engine HTTP boundaries', () => {
  it('propagates engine deadline options to the runner and advertises unavailable writes', async () => {
    let received: Parameters<CodexRunnerInterface['propose']>[0] | undefined;
    engine = await startEngine({ workspaceRoot: root, proposalTimeoutMs: 2345, runner: {
      mode: 'fake', propose: async (input) => { received = input; return { summary: 'read only', edits: [] }; },
    } });
    const res = await fetch(engine.url + '/v1/tasks', { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${engine.token}`,
    }, body: JSON.stringify(requestBody()) });
    expect(res.status).toBe(201);
    expect(received?.timeoutMs).toBe(2345);
    expect(received?.signal).toBeInstanceOf(AbortSignal);
    const health = await (await fetch(engine.url + '/health')).json();
    expect(health.automaticApplyAvailable).toBe(false);
    expect(health.applicationUnavailableCode).toBe('SAFE_WRITE_UNAVAILABLE');
  });

  it('returns controlled errors for malformed targets and remains healthy', async () => {
    engine = await startEngine({ workspaceRoot: root, useFakeRunner: true });
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: engine!.port, path: 'http://[', method: 'GET' }, (res) => {
        res.resume(); res.once('end', () => resolve(res.statusCode));
      }); req.on('error', reject); req.end();
    });
    expect(status).toBe(400);
    expect((await fetch(engine.url + '/health')).status).toBe(200);
  });
});
