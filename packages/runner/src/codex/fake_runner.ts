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
    const targetFile = input.targetFiles?.[0] ?? input.sourceHints?.[0]?.filePath ?? 'src/example.ts';
    return {
      summary: `Deterministic proposal for: ${input.prompt}`,
      edits: [
        {
          path: targetFile,
          changeType: 'update',
          oldContent: '// old content\n',
          newContent: '// modified content by fake runner\n',
          description: 'Deterministic fake modification for testing',
        },
      ],
      rawEvents: [{ event: 'fake_completion', timestamp: Date.now() }],
    };
  }
}
