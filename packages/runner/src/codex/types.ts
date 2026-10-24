import type { SourceHint } from '../envelope.js';
import type { FileChangeType } from '@summon-fixer/contracts';

export interface ProposedEdit {
  path: string;
  changeType: FileChangeType;
  oldContent?: string | null;
  newContent?: string | null;
  description?: string;
}

export interface CodexDiagnostic {
  stage: 'starting' | 'spawned' | 'first_output' | 'first_event' | 'proposal_received' | 'exited' | 'completed' | 'failed';
  elapsedMs: number;
  timeoutMs: number;
}

export interface CodexProposalInput {
  prompt: string;
  workspaceRoot: string;
  targetFiles?: string[];
  sourceHints?: SourceHint[];
  timeoutMs?: number;
  signal?: AbortSignal;
  onDiagnostic?: (diagnostic: CodexDiagnostic) => void;
}

export interface CodexProposalOutput {
  summary: string;
  edits: ProposedEdit[];
  rawEvents?: unknown[];
}

export interface CodexRunnerInterface {
  readonly mode: 'real' | 'fake';
  propose(input: CodexProposalInput): Promise<CodexProposalOutput>;
}
