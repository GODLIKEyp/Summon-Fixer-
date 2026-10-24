import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PromptPanelController } from '../prompt-panel.js';
import { SummonApiClient, SummonApiError } from '../client-api.js';
import { setupTestDom } from './test-dom.js';

const digest = 'a'.repeat(64);
const deferred = () => { let resolve!: (value: any) => void; let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const selected = () => ({ element: document.createElement('button'), tagName: 'BUTTON', textContent: 'Checkout Now',
  elementSelector: '#checkout', attributes: {}, surroundingContext: '', sourceId: 'src_checkout', sourceRevision: 'revision',
  sourceLocation: { file: 'src/App.tsx', line: 1, column: 1 } });
function task(status = 'awaiting_approval'): any {
  return { taskId: 'task-1', version: 1, status, effectiveMode: 'manual', edits: [],
    proposal: { proposalId: 'proposal', taskVersion: 1, proposalDigest: digest, totalFiles: 1, summary: 'Make purple',
      edits: [{ path: 'src/App.tsx', changeType: 'update', status: 'pending', oldContent: 'background: blue', newContent: 'background: purple' }] } };
}
function harness(api: any = {}) {
  const listeners = new Map<string, () => void>();
  const container = { innerHTML: '', querySelector(selector: string) {
    return { addEventListener: (event: string, cb: () => void) => listeners.set(selector + ':' + event, cb), focus() {} };
  }, querySelectorAll() { return ['manual', 'plan', 'auto'].map(mode => ({
    getAttribute: () => mode, addEventListener: (_: string, cb: () => void) => listeners.set(mode, cb),
  })); } };
  const panel = new PromptPanelController(container as any, api, { onClose() {}, onReselect() {} });
  panel.open(selected());
  const internal = panel as any;
  const show = (state: any) => { internal.state.currentTaskId = state.taskId; internal.state.currentTaskState = state; internal.render(); };
  return { panel, internal, container, listeners, show };
}
beforeEach(() => { vi.useFakeTimers(); setupTestDom(); vi.stubGlobal('window', { setInterval, clearInterval, location: { href: 'http://localhost/' } }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Production approval renderer', () => {
  it('shows exact removals/additions and review identity while escaping all source and metadata', () => {
    const h = harness(); const t = task();
    const malicious = '<img src=x onerror="alert(1)">';
    t.proposal.summary = malicious; t.proposal.edits[0].path = 'src/<script>.tsx';
    t.proposal.edits[0].oldContent = '</pre><script>alert(1)</script>';
    t.proposal.edits[0].newContent = malicious;
    h.show(t);
    expect(h.container.innerHTML).toContain('− Removed / before');
    expect(h.container.innerHTML).toContain('+ Added / after');
    expect(h.container.innerHTML).toContain('&lt;/pre&gt;&lt;script&gt;');
    expect(h.container.innerHTML).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(h.container.innerHTML).not.toContain('<img');
    expect(h.container.innerHTML).not.toContain('<script>');
    expect(h.container.innerHTML).toContain('Task task-1 · version 1');
    expect(h.container.innerHTML).toContain(digest);
    expect(h.container.innerHTML).toMatch(/id="summon-btn-approve"\s*>/);
  });
  it.each(['missingBefore', 'patchOnly', 'missingDigest', 'wrongVersion', 'wrongTask', 'multiFile', 'plan', 'missingEdits', 'nullEdit'])('disables unreviewable %s proposals', variant => {
    const h = harness(); const t = task();
    if (variant === 'missingBefore') delete t.proposal.edits[0].oldContent;
    if (variant === 'patchOnly') { delete t.proposal.edits[0].newContent; t.proposal.edits[0].patch = '@@'; }
    if (variant === 'missingDigest') delete t.proposal.proposalDigest;
    if (variant === 'wrongVersion') t.proposal.taskVersion++;
    if (variant === 'multiFile') t.proposal.edits.push(t.proposal.edits[0]);
    if (variant === 'plan') t.effectiveMode = 'plan';
    if (variant === 'missingEdits') delete t.proposal.edits;
    if (variant === 'nullEdit') t.proposal.edits = [null];
    h.show(t);
    if (variant === 'wrongTask') { h.internal.state.currentTaskId = 'other'; h.internal.render(); }
    expect(h.container.innerHTML).toContain('id="summon-btn-approve" disabled');
  });
  it('escapes selected text, prompt, source labels, progress and malformed review identity', () => {
    const h = harness(); const attack = '<img src=x onerror="alert(1)">';
    h.panel.open({ ...selected(), textContent: attack, tagName: attack, sourceLocation: { file: attack, line: 1, column: 1 } });
    h.internal.state.promptText = attack;
    h.show({ ...task('planning'), progress: { phase: attack, message: attack, percentage: Infinity } });
    expect(h.container.innerHTML).not.toContain('<img'); expect(h.container.innerHTML).toContain('&lt;img');
    expect(h.container.innerHTML).not.toContain('Infinity%');
    h.show({ ...task(), taskId: attack, version: attack });
    expect(h.container.innerHTML).not.toContain('<img'); expect(h.container.innerHTML).toContain('id="summon-btn-approve" disabled');
  });
  it('binds clicks to the displayed proposal and submits each approval at most once', async () => {
    const response = deferred(); const api = { submitApproval: vi.fn(() => response.promise), getTask: vi.fn(() => new Promise(() => {})) };
    const h = harness(api); const t = task(); h.show(t);
    const oldClick = h.listeners.get('#summon-btn-approve:click')!;
    t.proposal.edits[0].newContent = 'unreviewed'; oldClick();
    expect(api.submitApproval).not.toHaveBeenCalled();
    h.show(t); const click = h.listeners.get('#summon-btn-approve:click')!; click(); click();
    expect(api.submitApproval).toHaveBeenCalledTimes(1);
    expect(api.submitApproval.mock.calls[0]).toEqual(['task-1', expect.objectContaining({ taskVersion: 1, proposalDigest: digest, decision: 'approved' })]);
    response.resolve({ success: true, state: task() }); await Promise.resolve(); await Promise.resolve();
    h.listeners.get('#summon-btn-approve:click')!();
    expect(api.submitApproval).toHaveBeenCalledTimes(1);
    h.panel.destroy();
  });
});

describe('Panel lifecycle guards', () => {
  it('preserves the source-review DOM during unchanged polling', async () => {
    const api = { getTask: vi.fn(async () => task()) };
    const h = harness(api); h.show(task());
    const render = vi.spyOn(h.internal, 'render');
    await h.internal.pollTask('task-1');
    expect(render).not.toHaveBeenCalled();
  });
  it.each(['resolve', 'reject'])('ignores an old task creation %s after reselection', async result => {
    const pending = deferred(); const api = { createTask: vi.fn(() => pending.promise), getTask: vi.fn() };
    const h = harness(api); h.internal.state.promptText = 'Purple';
    const running = h.internal.handleSubmit(); h.panel.close(); h.panel.open({ ...selected(), textContent: 'New selection' });
    if (result === 'resolve') pending.resolve({ taskId: 'task-1', state: task('planning') }); else pending.reject(new Error('Old error'));
    await running;
    expect(h.panel.getState().currentTaskId).toBeNull(); expect(h.panel.getState().connectionError).toBeNull();
    expect(api.getTask).not.toHaveBeenCalled(); expect(h.container.innerHTML).toContain('New selection');
  });
  it.each(['resolve', 'reject'])('ignores an old poll %s and finally handler while a new panel polls', async result => {
    const old = deferred(), fresh = deferred(); const api = { getTask: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise) };
    const h = harness(api); h.show(task('planning')); const oldPoll = h.internal.pollTask('task-1');
    h.panel.open(selected()); h.show({ ...task('planning'), taskId: 'task-2' }); const newPoll = h.internal.pollTask('task-2');
    if (result === 'reject') old.reject(new Error('Old poll failed')); else old.resolve(task('completed'));
    await oldPoll;
    await h.internal.pollTask('task-2'); expect(api.getTask).toHaveBeenCalledTimes(2);
    fresh.resolve({ ...task('completed'), taskId: 'task-2' }); await newPoll;
    expect(h.panel.getState().currentTaskState?.taskId).toBe('task-2'); expect(h.panel.getState().connectionError).toBeNull();
  });
  it.each(['resolve', 'reject'])('ignores an old approval %s after reopening', async result => {
    const pending = deferred(); const api = { submitApproval: vi.fn(() => pending.promise), getTask: vi.fn() };
    const h = harness(api); h.show(task()); const running = h.internal.handleApproval('approved', h.internal.reviewKey(task()));
    h.panel.open(selected());
    if (result === 'resolve') pending.resolve({ state: task('completed') }); else pending.reject(new Error('Old approval failed'));
    await running; expect(h.panel.getState().currentTaskState).toBeNull(); expect(h.panel.getState().connectionError).toBeNull(); expect(api.getTask).not.toHaveBeenCalled();
  });
  it('does not accept an in-flight pre-approval poll after approving', async () => {
    const old = deferred(); const api = { getTask: vi.fn(() => old.promise), submitApproval: vi.fn(() => new Promise(() => {})) };
    const h = harness(api); h.show(task()); const poll = h.internal.pollTask('task-1');
    void h.internal.handleApproval('approved', h.internal.reviewKey(task())); old.resolve(task('completed')); await poll;
    expect(h.panel.getState().isSubmitting).toBe(true); expect(h.panel.getState().currentTaskState?.status).toBe('awaiting_approval');
  });
});

describe('Authoritative outcomes and errors', () => {
  it('freezes mode during planning and derives completed writes from edit status', () => {
    const h = harness(); h.show(task('planning')); h.listeners.get('plan')!();
    expect(h.panel.getState().permissionMode).toBe('manual');
    h.internal.state.permissionMode = 'plan';
    h.show({ ...task('completed'), edits: [{ status: 'applied' }], completion: { type: 'edits_applied', summary: 'Applied' } });
    expect(h.container.innerHTML).toContain('1 file(s) updated on disk.'); expect(h.container.innerHTML).not.toContain('No files were modified.');
  });
  it('shows plan completion without claiming a write from proposed edits', () => {
    const h = harness(); h.show({ ...task('completed'), effectiveMode: 'plan', edits: [{ status: 'pending' }], completion: { type: 'read_only' } });
    expect(h.container.innerHTML).toContain('No files were modified.');
  });
  it.each(['applied', 'pending', 'failed'])('handles verification failure with %s edit evidence', status => {
    const h = harness(); h.show({ ...task('failed'), edits: [{ status }], verification: { status: 'failed' }, error: { message: 'Syntax error' } });
    expect(h.container.innerHTML).toContain(status === 'applied' ? 'File modified, but verification failed.' : status === 'pending' ? 'No edit is reported as applied.' : 'File modification status is uncertain.');
  });
  it.each(['timeout', 'authorization', 'validation', 'connectivity'] as const)('preserves %s errors in the renderer', kind => {
    const h = harness(); h.internal.reportError(new SummonApiError('Specific <failure>', kind, 409, 'CODE', { reason: 'test' })); h.internal.render();
    expect(h.container.innerHTML).toContain('Specific &lt;failure&gt;');
    expect(h.container.innerHTML).toContain({ timeout: 'Request timed out', authorization: 'Authorization required', validation: 'Request needs attention', connectivity: 'Connection unavailable' }[kind]);
  });
});

describe('Production API client', () => {
  it('bootstraps once, carries only the browser capability and preserves structured errors', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ capability: digest })))
      .mockResolvedValue(new Response(JSON.stringify({ error: { code: 'ERR_SOURCE_NOT_FOUND', message: 'Re-select', details: { source: 'gone' } } }), { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    const api = new SummonApiClient(); await expect(api.getTask('one')).rejects.toMatchObject({ kind: 'validation', code: 'ERR_SOURCE_NOT_FOUND', status: 404, details: { source: 'gone' } });
    await expect(api.getTask('two')).rejects.toBeInstanceOf(SummonApiError);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1][1].headers).toMatchObject({ 'X-Summon-Session': digest });
    expect(fetcher.mock.calls[1][1].headers).not.toHaveProperty('Authorization');
  });
  it('bounds a stalled fetch and reports timeout without retrying', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('abort'))))));
    const pending = new SummonApiClient({ timeoutMs: 20 }).getTask('one');
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout', code: 'ERR_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(21); await assertion; expect(fetch).toHaveBeenCalledTimes(1);
  });
});
