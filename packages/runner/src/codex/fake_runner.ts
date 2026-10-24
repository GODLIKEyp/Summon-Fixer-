import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  CodexRunnerInterface,
  CodexProposalInput,
  CodexProposalOutput,
} from './types.js';

export class FakeCodexRunner implements CodexRunnerInterface {
  readonly mode = 'fake' as const;
  private queuedOutputs: CodexProposalOutput[] = [];
  private calls: CodexProposalInput[] = [];

  constructor(initialOutputs?: CodexProposalOutput[]) {
    if (initialOutputs) {
      this.queuedOutputs.push(...initialOutputs);
    }
  }

  queueOutput(output: CodexProposalOutput): void {
    this.queuedOutputs.push(output);
  }

  getCallHistory(): readonly CodexProposalInput[] {
    return this.calls;
  }

  clearHistory(): void {
    this.calls = [];
  }

  async propose(input: CodexProposalInput): Promise<CodexProposalOutput> {
    this.calls.push(input);

    const next = this.queuedOutputs.shift();
    if (next) {
      return next;
    }

    // Default deterministic fallback response
    const targetFile =
      input.targetFiles?.[0] ??
      input.sourceHints?.[0]?.filePath ??
      'apps/demo/src/App.tsx';

    const absPath = resolve(input.workspaceRoot, targetFile);

    let oldContent: string | null = '// old content\n';
    let newContent: string | null = '// modified content by fake runner\n';

    if (existsSync(absPath)) {
      const diskText = readFileSync(absPath, 'utf-8');
      const isPurplePrompt = input.prompt.toLowerCase().includes('purple');
      const isButtonTarget =
        targetFile.includes('App.tsx') ||
        input.prompt.toLowerCase().includes('button') ||
        input.sourceHints?.some((h) => h.elementTag === 'BUTTON' || h.elementTag === 'button');

      if (isPurplePrompt && isButtonTarget && diskText.includes('id="checkout-now-button"')) {
        const lines = diskText.split('\n');
        const btnLineIdx = lines.findIndex((l) => l.includes('id="checkout-now-button"'));
        if (btnLineIdx !== -1) {
          const classLineIdx = btnLineIdx > 0 && lines[btnLineIdx - 1].includes('className="btn btn-primary"')
            ? btnLineIdx - 1
            : btnLineIdx;

          if (lines[classLineIdx].includes('className="btn btn-primary"')) {
            oldContent = lines[classLineIdx];
            newContent = lines[classLineIdx].replace(
              'className="btn btn-primary"',
              'className="btn btn-primary" style={{ backgroundColor: "#9333ea" }} /* [FAKE RUNNER: purple] */'
            );
          } else {
            oldContent = lines[btnLineIdx];
            newContent = `${lines[btnLineIdx]} /* [FAKE RUNNER: purple] */`;
          }
        }
      } else {
        const firstLine = diskText.split('\n')[0] ?? '';
        oldContent = firstLine + '\n';
        newContent = `/* [FAKE RUNNER] simulated edit */\n${firstLine}\n`;
      }
    }

    return {
      summary: `[FAKE RUNNER] Deterministic proposal for: ${input.prompt}`,
      edits: [
        {
          path: targetFile,
          changeType: 'update',
          oldContent,
          newContent,
          description: '[FAKE RUNNER] Visibly distinguishable simulated change for integration verification',
        },
      ],
      rawEvents: [{ event: 'fake_completion', timestamp: Date.now() }],
    };
  }
}
