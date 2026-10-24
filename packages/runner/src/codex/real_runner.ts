import { existsSync, readdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_PROPOSAL_TIMEOUT_MS, validateTimeoutMs } from '../deadline.js';
import { runManagedProcess, ManagedProcessError } from '../process.js';
import { z } from 'zod';
import type {
  CodexRunnerInterface,
  CodexProposalInput,
  CodexProposalOutput,
} from './types.js';
import type { FileChangeType } from '@summon-fixer/contracts';

export const MAX_CODEX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2 MB limit

export const CodexOutputEditSchema = z.object({
  path: z.string().min(1, 'Path cannot be empty').max(500),
  changeType: z.enum(['create', 'update', 'delete']),
  oldContent: z.string().nullable().optional(),
  newContent: z.string().nullable().optional(),
  description: z.string().max(1000).optional(),
});

export const CodexProposalOutputSchema = z.object({
  summary: z.string().min(1, 'Summary cannot be empty').max(2000),
  edits: z.array(CodexOutputEditSchema).max(100),
});

export class CodexExecutionError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'CodexExecutionError';
  }
}

/** Only schema-owned field names are allowed in diagnostics, never model values. */
function schemaIssuePath(path: PropertyKey[]): string {
  if (path.length === 1 && (path[0] === 'summary' || path[0] === 'edits')) return path[0];
  if (path[0] === 'edits' && typeof path[1] === 'number') {
    if (path.length === 2) return 'edits[]';
    if (path.length === 3 && typeof path[2] === 'string'
      && ['path', 'changeType', 'oldContent', 'newContent', 'description'].includes(path[2])) {
      return `edits[].${path[2]}`;
    }
  }
  return '$';
}

/**
 * One exec invocation produces one turn. Message completion alone is not turn
 * completion: unphased agent messages can be progress text or draft proposals.
 * Select the last message by ordering, never the last *schema-valid* message.
 */
function parseCompletedProposal(stdout: string): CodexProposalOutput {
  let finalText: unknown;
  let messageCount = 0;
  let turnStarted = false;
  let turnCompleted = false;
  let invalidOrder = false;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event: any;
    try { event = JSON.parse(line); }
    catch { throw new CodexExecutionError('Codex returned malformed event output', { code: 'MALFORMED_OUTPUT' }); }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      throw new CodexExecutionError('Codex returned malformed event output', { code: 'MALFORMED_OUTPUT' });
    }
    // Inspect the entire stream, including events after apparent completion.
    if (event.type === 'turn.failed' || event.type === 'error' || event.type === 'turn.cancelled') {
      throw new CodexExecutionError('Codex reported a failed or cancelled turn', { code: 'TURN_FAILED' });
    }
    if (turnCompleted) invalidOrder = true;
    if (event.type === 'turn.started') {
      if (turnStarted || messageCount > 0) invalidOrder = true;
      turnStarted = true;
    }
    if (event.type === 'turn.completed') turnCompleted = true;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      messageCount++;
      finalText = event.item.text;
    }
  }
  if (invalidOrder) throw new CodexExecutionError('Codex returned events outside a single completed turn', { code: 'MALFORMED_OUTPUT' });
  if (messageCount === 0) throw new CodexExecutionError('Codex completed without returning valid proposal output', { code: 'MISSING_OUTPUT' });
  if (!turnCompleted) throw new CodexExecutionError('Codex exited without a turn.completed event', { code: 'INCOMPLETE_TURN' });

  const invalid = (reason: string, issues: { path: string; code: string }[] = [], issueCount = issues.length) =>
    new CodexExecutionError(
      `Codex output failed schema validation (${reason}; final agent message #${messageCount}${issues.length
        ? '; ' + issues.map((issue) => `${issue.path}:${issue.code}`).join(', ') : ''})`,
      { code: 'MALFORMED_SCHEMA', reason, messageCount, issueCount, issues }
    );
  if (typeof finalText !== 'string') throw invalid('invalid_message_text');
  let structured: unknown;
  try { structured = JSON.parse(finalText); }
  catch { throw invalid('invalid_json'); }
  const parsed = CodexProposalOutputSchema.safeParse(structured);
  if (!parsed.success) {
    // Never expose Zod messages/inputs or JSON parser errors: they may contain
    // source text, credentials or arbitrary property names from model output.
    throw invalid('schema_mismatch', parsed.error.issues.slice(0, 5).map((issue) => ({
      path: schemaIssuePath(issue.path), code: issue.code,
    })), parsed.error.issues.length);
  }
  return {
    summary: parsed.data.summary,
    edits: parsed.data.edits.map((edit) => ({ ...edit, changeType: edit.changeType as FileChangeType,
      oldContent: edit.oldContent ?? null, newContent: edit.newContent ?? null })),
  };
}

/**
 * Searches candidate locations for the Codex CLI binary.
 */
export function resolveCodexBinaryPath(): string | null {
  if (process.env.CODEX_BIN_PATH && existsSync(process.env.CODEX_BIN_PATH)) {
    return process.env.CODEX_BIN_PATH;
  }

  // Check VS Code extension directory on macOS / Linux
  const homeDir = process.env.HOME;
  if (homeDir) {
    const vscodeExtDir = resolve(homeDir, '.vscode/extensions');
    if (existsSync(vscodeExtDir)) {
      try {
        const matches = readdirSync(vscodeExtDir).filter((d) =>
          d.startsWith('openai.chatgpt-')
        );
        for (const match of matches) {
          const binSubdirs = ['macos-aarch64', 'macos-x64', 'linux-x64'];
          for (const sub of binSubdirs) {
            const candidate = resolve(vscodeExtDir, match, 'bin', sub, 'codex');
            if (existsSync(candidate)) {
              return candidate;
            }
          }
        }
      } catch {
        // Continue fallback search
      }
    }
  }

  return null;
}

const CODEX_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          changeType: {
            type: 'string',
            enum: ['create', 'update', 'delete'],
          },
          oldContent: { type: 'string' },
          newContent: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['path', 'changeType', 'oldContent', 'newContent', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'edits'],
  additionalProperties: false,
};

export class RealCodexRunner implements CodexRunnerInterface {
  readonly mode = 'real' as const;
  private readonly binaryPath: string;

  constructor(binaryPath?: string) {
    const resolved = binaryPath ?? resolveCodexBinaryPath();
    if (!resolved) {
      throw new CodexExecutionError(
        'Could not locate Codex CLI binary. Set CODEX_BIN_PATH or ensure VS Code ChatGPT extension is installed.'
      );
    }
    this.binaryPath = resolved;
  }

  async propose(input: CodexProposalInput): Promise<CodexProposalOutput> {
    const { prompt, workspaceRoot, targetFiles, sourceHints, timeoutMs = DEFAULT_PROPOSAL_TIMEOUT_MS } = input;

    validateTimeoutMs(timeoutMs);
    const startedAt = performance.now();
    const report = (stage: import('./types.js').CodexDiagnostic['stage']) => {
      try { input.onDiagnostic?.({ stage, elapsedMs: Math.round(performance.now() - startedAt), timeoutMs }); }
      catch { /* A diagnostic subscriber cannot change proposal semantics. */ }
    };
    report('starting');

    // 2. Compose instruction prompt incorporating source hints
    let fullPrompt = `Task: ${prompt}\n\n`;
    if (sourceHints && sourceHints.length > 0) {
      fullPrompt += 'Context & Selected Element Source Hints:\n';
      for (const hint of sourceHints) {
        fullPrompt += `- File: ${hint.filePath}\n`;
        if (hint.lineRange) {
          fullPrompt += `  Lines: ${hint.lineRange.start}-${hint.lineRange.end}\n`;
        }
        if (hint.componentName) {
          fullPrompt += `  Component: ${hint.componentName}\n`;
        }
        if (hint.elementTag) {
          fullPrompt += `  Element Tag: <${hint.elementTag}>\n`;
        }
        if (hint.textContent) {
          fullPrompt += `  Text Content: "${hint.textContent}"\n`;
        }
      }
      fullPrompt += '\n';
    }

    if (targetFiles && targetFiles.length > 0) {
      fullPrompt += `Target Files:\n${targetFiles.map((f) => `- ${f}`).join('\n')}\n\n`;
    }

    fullPrompt +=
      'Instructions:\n' +
      '1. Inspect the permitted workspace repository to understand the implementation.\n' +
      '2. Propose the minimal, clean code modification satisfying the task.\n' +
      '3. For each file edit, provide the exact relative path, changeType ("create", "update", or "delete"), exact oldContent, and exact newContent.\n' +
      '4. Output strictly according to the provided schema.\n';

    // 3. Prepare child process environment
    const codexBinDir = dirname(this.binaryPath);
    const env = {
      ...process.env,
      PATH: `${codexBinDir}:${process.env.PATH ?? ''}`,
    };

    // The prompt goes over stdin, not the process command line. The schema is
    // non-secret, but still gets a private directory and exclusive creation.
    const schemaDir = mkdtempSync(resolve(tmpdir(), 'summon-schema-'));
    const schemaFile = resolve(schemaDir, 'output.json');
    try {
      writeFileSync(schemaFile, JSON.stringify(CODEX_OUTPUT_SCHEMA), { flag: 'wx', mode: 0o600 });
      let observed = '';
      let reportedEvent = false;
      const observe = (text: string) => {
        observed += text;
        const lines = observed.split('\n');
        observed = lines.pop() ?? '';
        for (const line of lines) {
          try {
            JSON.parse(line);
            if (!reportedEvent) { reportedEvent = true; report('first_event'); }
          } catch { /* Authoritative validation runs after process completion. */ }
        }
      };
      const result = await runManagedProcess({
        command: this.binaryPath,
        args: ['exec', '-s', 'read-only', '--ephemeral', '--json', '--output-schema', schemaFile, '-'],
        cwd: workspaceRoot, env, input: fullPrompt, timeoutMs,
        signal: input.signal, maxOutputBytes: MAX_CODEX_OUTPUT_BYTES,
        onStage: report, onStdout: observe,
      });
      if (result.exitCode !== 0) {
        throw new CodexExecutionError(`Codex process exited with code ${result.exitCode}`, { code: 'NONZERO_EXIT' });
      }
      const output = parseCompletedProposal(result.stdout);
      // A schema-shaped intermediate message is not yet a received proposal.
      report('proposal_received');
      report('completed');
      return output;
    } catch (error) {
      report('failed');
      if (error instanceof ManagedProcessError) throw new CodexExecutionError(error.message, { code: error.code });
      if (error instanceof CodexExecutionError) throw error;
      throw new CodexExecutionError('Codex proposal setup or cleanup failed', { code: 'SETUP_FAILED' });
    } finally {
      rmSync(schemaDir, { recursive: true, force: true });
    }
  }
}
