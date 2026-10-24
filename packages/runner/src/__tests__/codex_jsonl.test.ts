import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runManagedProcess } from '../process.js';
import { CodexExecutionError, RealCodexRunner } from '../codex/real_runner.js';
import type { CodexDiagnostic } from '../codex/types.js';

vi.mock('../process.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../process.js')>(),
  runManagedProcess: vi.fn(),
}));

const proposal = { summary: 'Fixture proposal', edits: [{
  path: 'src/a.ts', changeType: 'update', oldContent: 'const a = 1;', newContent: 'const a = 2;',
}] };
const message = (text: unknown) => ({ type: 'item.completed', item: { type: 'agent_message', text } });
const completed = { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
const valid = message(JSON.stringify(proposal));
const input = { prompt: 'PRIVATE_PROMPT', workspaceRoot: process.cwd() };
function events(values: unknown[], exitCode = 0) {
  vi.mocked(runManagedProcess).mockResolvedValue({ stdout: values.map((value) => JSON.stringify(value)).join('\n'), exitCode });
}
beforeEach(() => vi.resetAllMocks());

describe('Codex JSONL final response selection (no model)', () => {
  it('accepts unphased intermediate text followed by a valid final response and turn completion', async () => {
    events([{ type: 'turn.started' }, message('I will inspect the selected source.'), valid, completed]);
    await expect(new RealCodexRunner('/mock/codex').propose(input)).resolves.toEqual(proposal);
  });

  it('selects the last message, ignoring drafts, phase hints and other completed items', async () => {
    events([
      { type: 'turn.started' }, valid,
      { ...message('Intermediate progress'), item: { ...message('Intermediate progress').item, phase: 'commentary' } },
      message('{"summary":"incomplete draft"}'),
      { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'PRIVATE_SOURCE' } },
      message(JSON.stringify({ ...proposal, summary: 'Authoritative final' })), completed,
    ]);
    await expect(new RealCodexRunner('/mock/codex').propose(input)).resolves.toEqual({ ...proposal, summary: 'Authoritative final' });
  });

  it.each([
    ['invalid JSON', message('PRIVATE_MODEL_OUTPUT'), 'invalid_json'],
    ['missing edits', message('{"summary":"PRIVATE_SOURCE"}'), 'schema_mismatch'],
    ['invalid enum', message(JSON.stringify({ ...proposal, edits: [{ ...proposal.edits[0], changeType: 'PRIVATE_CREDENTIAL' }] })), 'schema_mismatch'],
    ['non-string text', message(proposal), 'invalid_message_text'],
    ['missing text', message(undefined), 'invalid_message_text'],
    ['commentary after valid JSON', { type: 'item.completed', item: { type: 'agent_message', phase: 'commentary', text: 'PRIVATE_MODEL_OUTPUT' } }, 'invalid_json'],
  ])('rejects %s as final output instead of falling back to an earlier proposal', async (_, final, reason) => {
    events([valid, final, completed]);
    const error = await new RealCodexRunner('/mock/codex').propose(input).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CodexExecutionError);
    expect(error).toMatchObject({ details: { code: 'MALFORMED_SCHEMA', reason, messageCount: 2 } });
    expect(JSON.stringify(error) + String(error)).not.toMatch(/PRIVATE_|src\/a\.ts|const a/);
  });

  it('bounds schema diagnostics to safe field names and issue codes', async () => {
    events([message(JSON.stringify({ summary: '', edits: Array.from({ length: 10 }, () => ({
      path: '', changeType: 'PRIVATE_CREDENTIAL', oldContent: { PRIVATE_SOURCE: 'PRIVATE_MODEL_OUTPUT' },
    })) })), completed]);
    const error = await new RealCodexRunner('/mock/codex').propose(input).catch((error: unknown) => error);
    expect(error).toMatchObject({ details: {
      code: 'MALFORMED_SCHEMA', reason: 'schema_mismatch', issueCount: 31,
      issues: [
        { path: 'summary', code: 'too_small' }, { path: 'edits[].path', code: 'too_small' },
        { path: 'edits[].changeType', code: 'invalid_value' }, { path: 'edits[].oldContent', code: 'invalid_type' },
        { path: 'edits[].path', code: 'too_small' },
      ],
    } });
    expect(String(error)).toContain('edits[].changeType:invalid_value');
    expect(JSON.stringify(error) + String(error)).not.toContain('PRIVATE_');
    expect(String(error).length).toBeLessThan(400);
  });

  it.each([[], [{ type: 'turn.started' }, completed]])('rejects missing output: %j', async (...stream) => {
    events(stream);
    await expect(new RealCodexRunner('/mock/codex').propose(input)).rejects.toMatchObject({ details: { code: 'MISSING_OUTPUT' } });
  });

  it('rejects a valid message without turn completion even on exit zero', async () => {
    events([valid]);
    await expect(new RealCodexRunner('/mock/codex').propose(input)).rejects.toMatchObject({ details: { code: 'INCOMPLETE_TURN' } });
  });

  it.each(['turn.failed', 'turn.cancelled', 'error'])('rejects terminal %s before or after apparent success', async (type) => {
    const failure = { type, error: { message: 'PRIVATE_CREDENTIAL' }, message: 'PRIVATE_MODEL_OUTPUT' };
    for (const stream of [[failure, valid, completed], [valid, failure], [valid, completed, failure]]) {
      events(stream);
      const error = await new RealCodexRunner('/mock/codex').propose(input).catch((error: unknown) => error);
      expect(error).toMatchObject({ details: { code: 'TURN_FAILED' } });
      expect(JSON.stringify(error) + String(error)).not.toContain('PRIVATE_');
    }
  });

  it('rejects nonzero exit even with a valid completed proposal', async () => {
    events([valid, completed], 7);
    await expect(new RealCodexRunner('/mock/codex').propose(input)).rejects.toMatchObject({ details: { code: 'NONZERO_EXIT' } });
  });

  it.each([
    [valid, completed, valid], [valid, completed, completed],
    [valid, completed, { type: 'turn.started' }],
    [{ type: 'turn.started' }, valid, { type: 'turn.started' }, completed],
  ])('rejects messages outside one completed turn: %j', async (...stream) => {
    events(stream);
    await expect(new RealCodexRunner('/mock/codex').propose(input)).rejects.toMatchObject({ details: { code: 'MALFORMED_OUTPUT' } });
  });

  it.each(['PRIVATE_MALFORMED_EVENT', 'null', '[]', '{"type":42}'])('rejects malformed JSONL envelopes: %s', async (line) => {
    vi.mocked(runManagedProcess).mockResolvedValue({ stdout: `${JSON.stringify(valid)}\n${JSON.stringify(completed)}\n${line}`, exitCode: 0 });
    const error = await new RealCodexRunner('/mock/codex').propose(input).catch((error: unknown) => error);
    expect(error).toMatchObject({ details: { code: 'MALFORMED_OUTPUT' } });
    expect(JSON.stringify(error) + String(error)).not.toContain('PRIVATE_');
  });

  it('reports a proposal only after process completion and final validation, including an unterminated last line', async () => {
    const diagnostics: CodexDiagnostic[] = [];
    const stdout = [message('PRIVATE_PROGRESS'), valid, completed].map((event) => JSON.stringify(event)).join('\r\n');
    vi.mocked(runManagedProcess).mockImplementation(async (options) => {
      options.onStage?.('spawned');
      for (let index = 0; index < stdout.length; index += 13) options.onStdout?.(stdout.slice(index, index + 13));
      expect(diagnostics.map((value) => value.stage)).not.toContain('proposal_received');
      options.onStage?.('exited');
      return { stdout, exitCode: 0 };
    });
    await expect(new RealCodexRunner('/mock/codex').propose({ ...input, onDiagnostic: (value) => diagnostics.push(value) })).resolves.toEqual(proposal);
    expect(diagnostics.map((value) => value.stage)).toEqual(['starting', 'spawned', 'first_event', 'exited', 'proposal_received', 'completed']);
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE_');
  });

  it('does not announce a proposal for an invalid final response', async () => {
    events([valid, message('PRIVATE_OUTPUT'), completed]);
    const diagnostics: CodexDiagnostic[] = [];
    await expect(new RealCodexRunner('/mock/codex').propose({ ...input, onDiagnostic: (value) => diagnostics.push(value) }))
      .rejects.toMatchObject({ details: { code: 'MALFORMED_SCHEMA' } });
    expect(diagnostics.map((value) => value.stage)).toEqual(['starting', 'failed']);
  });
});
