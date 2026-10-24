import { spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type {
  CodexRunnerInterface,
  CodexProposalInput,
  CodexProposalOutput,
  ProposedEdit,
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
    const { prompt, workspaceRoot, targetFiles, sourceHints, timeoutMs = 60_000 } = input;

    // 1. Write strict schema to temporary file
    const schemaFile = resolve(
      tmpdir(),
      `summon-schema-${randomBytes(8).toString('hex')}.json`
    );
    writeFileSync(schemaFile, JSON.stringify(CODEX_OUTPUT_SCHEMA, null, 2), 'utf-8');

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

    const args = [
      'exec',
      '-s',
      'read-only',
      '--ephemeral',
      '--json',
      '--output-schema',
      schemaFile,
      fullPrompt,
    ];

    return new Promise<CodexProposalOutput>((resolvePromise, rejectPromise) => {
      const child = spawn(this.binaryPath, args, {
        cwd: workspaceRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let totalOutputBytes = 0;
      let killedDueToOversized = false;
      const rawEvents: unknown[] = [];
      let parsedOutput: CodexProposalOutput | null = null;
      let lastSchemaError: z.ZodError | null = null;

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        cleanup();
        rejectPromise(
          new CodexExecutionError(`Codex execution timed out after ${timeoutMs}ms`)
        );
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        try {
          if (existsSync(schemaFile)) {
            unlinkSync(schemaFile);
          }
        } catch {
          // ignore cleanup errors
        }
      };

      const handleChunk = (chunk: Buffer, isStderr: boolean) => {
        if (killedDueToOversized) return;
        totalOutputBytes += chunk.length;
        if (totalOutputBytes > MAX_CODEX_OUTPUT_BYTES) {
          killedDueToOversized = true;
          child.kill('SIGKILL');
          cleanup();
          rejectPromise(
            new CodexExecutionError(
              `Codex execution exceeded maximum output limit of ${MAX_CODEX_OUTPUT_BYTES} bytes`,
              { code: 'OUTPUT_TOO_LARGE' }
            )
          );
          return;
        }

        if (isStderr) {
          stderrBuffer += chunk.toString('utf-8');
          return;
        }

        const text = chunk.toString('utf-8');
        stdoutBuffer += text;

        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            rawEvents.push(event);

            // Check for completed agent message containing structured response
            if (
              event.type === 'item.completed' &&
              event.item?.type === 'agent_message' &&
              typeof event.item?.text === 'string'
            ) {
              try {
                const structured = JSON.parse(event.item.text);
                const validated = CodexProposalOutputSchema.safeParse(structured);
                if (validated.success) {
                  parsedOutput = {
                    summary: validated.data.summary,
                    edits: validated.data.edits.map((e) => ({
                      path: e.path,
                      changeType: e.changeType as FileChangeType,
                      oldContent: e.oldContent ?? null,
                      newContent: e.newContent ?? null,
                      description: e.description,
                    })),
                    rawEvents,
                  };
                } else {
                  lastSchemaError = validated.error;
                }
              } catch {
                // Not JSON text yet
              }
            }
          } catch {
            // Non-JSON line from stdout
          }
        }
      };

      child.stdout.on('data', (chunk: Buffer) => handleChunk(chunk, false));
      child.stderr.on('data', (chunk: Buffer) => handleChunk(chunk, true));

      child.on('error', (err) => {
        cleanup();
        rejectPromise(
          new CodexExecutionError(`Failed to spawn Codex CLI: ${err.message}`, err)
        );
      });

      child.on('close', (code) => {
        cleanup();
        if (killedDueToOversized) return;

        // Nonzero process exit MUST fail, even if partial output was parsed earlier
        if (code !== 0) {
          rejectPromise(
            new CodexExecutionError(
              `Codex process exited with code ${code}. Stderr: ${stderrBuffer.trim()}`,
              { code, stderr: stderrBuffer }
            )
          );
          return;
        }

        if (stdoutBuffer.trim()) {
          try {
            const event = JSON.parse(stdoutBuffer.trim());
            rawEvents.push(event);
            if (
              event.type === 'item.completed' &&
              event.item?.type === 'agent_message' &&
              typeof event.item?.text === 'string'
            ) {
              const structured = JSON.parse(event.item.text);
              const validated = CodexProposalOutputSchema.safeParse(structured);
              if (validated.success) {
                parsedOutput = {
                  summary: validated.data.summary,
                  edits: validated.data.edits.map((e) => ({
                    path: e.path,
                    changeType: e.changeType as FileChangeType,
                    oldContent: e.oldContent ?? null,
                    newContent: e.newContent ?? null,
                    description: e.description,
                  })),
                  rawEvents,
                };
              } else {
                lastSchemaError = validated.error;
              }
            }
          } catch {
            // ignore trailing non-JSON
          }
        }

        if (parsedOutput) {
          resolvePromise(parsedOutput);
          return;
        }

        if (lastSchemaError) {
          rejectPromise(
            new CodexExecutionError(
              `Codex output failed schema validation: ${lastSchemaError.message}`,
              { code: 'MALFORMED_SCHEMA', details: lastSchemaError.format() }
            )
          );
          return;
        }

        // Process exited cleanly but no structured output matched
        rejectPromise(
          new CodexExecutionError(
            `Codex completed without returning valid proposal output. Stderr: ${stderrBuffer.trim()}`,
            { code: 'MISSING_OUTPUT', stdout: stdoutBuffer, stderr: stderrBuffer, rawEvents }
          )
        );
      });
    });
  }
}
