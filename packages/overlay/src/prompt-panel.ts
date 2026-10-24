import type { TaskRequest, TaskState, PermissionMode, EditApprovalResponse } from '@summon-fixer/contracts';
import type { SelectedElementContext, OverlayState } from './types.js';
import { SummonApiClient, SummonApiError } from './client-api.js';

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export interface PromptPanelCallbacks {
  onClose: () => void;
  onReselect: () => void;
  onStateChange?: (state: OverlayState) => void;
}

export class PromptPanelController {
  private pollIntervalId: number | null = null;
  private pollInFlight: number | null = null;
  private generation = 0;
  private approvalSentKey: string | null = null;
  private errorTitle = 'Request failed';
  private state: OverlayState = {
    pointModeActive: false, selectedElement: null, panelOpen: false, promptText: '', permissionMode: 'manual',
    currentTaskId: null, currentTaskState: null, isSubmitting: false, isPolling: false,
    engineConnected: true, connectionError: null,
  };
  constructor(private panelContainer: HTMLElement, private apiClient: SummonApiClient, private callbacks: PromptPanelCallbacks) {}
  public getState(): OverlayState { return { ...this.state }; }

  private isCurrent(generation: number, taskId?: string): boolean {
    return this.state.panelOpen && this.generation === generation && (taskId === undefined || this.state.currentTaskId === taskId);
  }
  private reportError(err: unknown): void {
    const kind = err instanceof SummonApiError ? err.kind : 'execution';
    this.errorTitle = { timeout: 'Request timed out', authorization: 'Authorization required', validation: 'Request needs attention',
      connectivity: 'Connection unavailable', execution: 'Request failed' }[kind];
    this.state.connectionError = err instanceof Error ? err.message : 'Request failed.';
    this.state.engineConnected = kind !== 'connectivity';
  }
  private approvalIdentity(task: TaskState | null): string {
    return JSON.stringify([task?.taskId, task?.version, task?.proposal?.proposalDigest]);
  }
  private reviewKey(task: TaskState | null): string | null {
    const plan = task?.proposal;
    if (!task || task.taskId !== this.state.currentTaskId || task.status !== 'awaiting_approval' || task.effectiveMode !== 'manual' ||
        !Number.isSafeInteger(task.version) || task.version < 1 || !plan || plan.taskVersion !== task.version ||
        !/^[a-f0-9]{64}$/.test(plan.proposalDigest || '') || !Array.isArray(plan.edits) || plan.edits.length !== 1 ||
        (plan.totalFiles !== undefined && plan.totalFiles !== plan.edits.length)) return null;
    const edit = plan.edits[0];
    if (!edit || edit.changeType !== 'update' || !edit.path || /(^[/\\]|(^|[/\\])\.\.([/\\]|$)|:)/.test(edit.path) ||
        typeof edit.oldContent !== 'string' || !edit.oldContent || typeof edit.newContent !== 'string' ||
        edit.oldContent === edit.newContent || edit.patch || edit.oldContent.length + edit.newContent.length > 500_000) return null;
    return JSON.stringify([task.taskId, task.version, plan.proposalDigest, plan.edits]);
  }
  public open(selectedElement: SelectedElementContext): void {
    this.stopPolling();
    this.generation++;
    this.approvalSentKey = null;
    this.state.currentTaskId = null;
    this.state.currentTaskState = null;
    this.state.isSubmitting = false;
    this.state.selectedElement = selectedElement;
    this.state.panelOpen = true;
    this.state.connectionError = null;
    this.render();
  }
  public close(): void {
    this.generation++;
    this.stopPolling();
    this.state.panelOpen = false;
    this.state.currentTaskId = null;
    this.state.currentTaskState = null;
    this.state.isSubmitting = false;
    this.state.connectionError = null;
    this.render();
    this.callbacks.onClose();
  }
  public destroy(): void {
    this.generation++;
    this.state.panelOpen = false;
    this.stopPolling();
    this.panelContainer.innerHTML = '';
  }
  private stopPolling(): void {
    if (this.pollIntervalId !== null) window.clearInterval(this.pollIntervalId);
    this.pollIntervalId = null;
    this.state.isPolling = false;
  }
  private startPolling(taskId: string): void {
    this.stopPolling();
    if (this.state.currentTaskState && ['completed', 'failed', 'cancelled'].includes(this.state.currentTaskState.status)) return;
    this.state.isPolling = true;
    const generation = this.generation;
    void this.pollTask(taskId, generation);
    this.pollIntervalId = window.setInterval(() => void this.pollTask(taskId, generation), 700);
  }
  private async pollTask(taskId: string, generation = this.generation): Promise<void> {
    if (!this.isCurrent(generation, taskId) || this.pollInFlight === generation || this.state.isSubmitting) return;
    this.pollInFlight = generation;
    try {
      const taskState = await this.apiClient.getTask(taskId);
      if (!this.isCurrent(generation, taskId)) return;
      if (taskState.taskId !== taskId) throw new Error('Engine returned a different task. Close and re-select the element.');
      if (this.state.currentTaskState && taskState.version < this.state.currentTaskState.version) return;
      // Keep the review DOM (scroll position and text selection) intact on unchanged polls.
      if (!this.state.connectionError && JSON.stringify(taskState) === JSON.stringify(this.state.currentTaskState)) return;
      this.state.currentTaskState = taskState;
      this.state.connectionError = null;
      this.state.engineConnected = true;
      if (['completed', 'failed', 'cancelled'].includes(taskState.status)) this.stopPolling();
      this.render();
    } catch (err) {
      if (!this.isCurrent(generation, taskId)) return;
      this.reportError(err);
      this.stopPolling();
      this.render();
    } finally {
      if (this.pollInFlight === generation) this.pollInFlight = null;
    }
  }
  private async handleSubmit(): Promise<void> {
    if (!this.state.panelOpen || this.state.isSubmitting) return;
    if (this.state.currentTaskId) {
      if (!this.state.currentTaskState || !['failed', 'cancelled'].includes(this.state.currentTaskState.status)) return;
      this.stopPolling();
      this.generation++;
      this.state.currentTaskId = null;
      this.state.currentTaskState = null;
      this.approvalSentKey = null;
    }
    const generation = this.generation;
    const prompt = this.state.promptText.trim();
    const sel = this.state.selectedElement;
    if (!sel) return;
    if (!prompt || prompt.length > 10_000 || !sel.sourceId || !sel.sourceRevision) {
      this.reportError(new SummonApiError('Enter an instruction (1–10,000 characters) and select an element with a current source mapping and revision.', 'validation', 400, 'ERR_INVALID_SELECTION'));
      this.render();
      return;
    }
    this.state.isSubmitting = true;
    this.state.connectionError = null;
    this.render();
    const taskRequest: TaskRequest = {
      requestId: `req_${crypto.randomUUID()}`, prompt, requestedMode: this.state.permissionMode,
      priority: 'normal', createdAt: new Date().toISOString(),
      context: {
        relevantFiles: [], sourceSelection: { sourceId: sel.sourceId, revision: sel.sourceRevision },
        ui: { componentName: sel.tagName, elementSelector: sel.elementSelector, renderedUrl: window.location.href },
        client: { clientType: 'overlay', clientVersion: '0.1.0' },
        metadata: { elementContext: { tagName: sel.tagName, textContent: sel.textContent,
          accessibleLabel: sel.accessibleLabel, attributes: sel.attributes, surroundingContext: sel.surroundingContext } },
      },
    };
    try {
      const res = await this.apiClient.createTask(taskRequest);
      if (!this.isCurrent(generation)) return;
      if (!res.taskId || (res.state && res.state.taskId !== res.taskId)) throw new Error('Engine returned an invalid task identity.');
      this.state.isSubmitting = false;
      this.state.currentTaskId = res.taskId;
      this.state.currentTaskState = res.state ?? null;
      this.render();
      this.startPolling(res.taskId);
    } catch (err) {
      if (!this.isCurrent(generation)) return;
      this.state.isSubmitting = false;
      this.reportError(err);
      this.render();
    }
  }
  private async handleApproval(decision: 'approved' | 'rejected', displayedKey: string | null): Promise<void> {
    const task = this.state.currentTaskState;
    if (!task?.proposal || !this.state.panelOpen || this.state.isSubmitting || !displayedKey ||
        displayedKey !== this.reviewKey(task) || this.approvalSentKey === this.approvalIdentity(task)) return;
    const generation = ++this.generation;
    const taskId = task.taskId;
    this.approvalSentKey = this.approvalIdentity(task);
    this.state.isSubmitting = true;
    this.state.connectionError = null;
    this.stopPolling();
    this.render();
    const approvalResponse: EditApprovalResponse = {
      taskId, taskVersion: task.version, proposalDigest: task.proposal.proposalDigest!, decision, respondedAt: new Date().toISOString(),
    };
    try {
      const response = await this.apiClient.submitApproval(taskId, approvalResponse);
      if (!this.isCurrent(generation, taskId)) return;
      if (response.state && response.state.taskId !== taskId) throw new Error('Engine returned a different approval task.');
      this.state.isSubmitting = false;
      if (response.state) this.state.currentTaskState = response.state;
      this.render();
      this.startPolling(taskId);
    } catch (err) {
      if (!this.isCurrent(generation, taskId)) return;
      this.state.isSubmitting = false;
      this.reportError(err);
      this.render();
      // A failed HTTP response may follow a successful write. Reconcile without replaying approval.
      this.startPolling(taskId);
    }
  }

  private render(): void {
    if (!this.state.panelOpen) {
      this.panelContainer.innerHTML = '';
      return;
    }

    const sel = this.state.selectedElement;
    const task = this.state.currentTaskState;
    const status = task ? task.status : (this.state.isSubmitting ? 'submitting' : 'idle');
    const reviewKey = this.reviewKey(task);
    const approvalDisabled = !reviewKey || this.state.isSubmitting || this.approvalSentKey === this.approvalIdentity(task);

    let sourceBadgeHtml = '';
    if (sel?.sourceLocation) {
      const fileName = escapeHtml(sel.sourceLocation.file.split('/').pop() || sel.sourceLocation.file);
      const fullLoc = escapeHtml(`${sel.sourceLocation.file}:${sel.sourceLocation.line}`);
      sourceBadgeHtml = `
        <div class="summon-source-badge" title="${fullLoc}">
          <span class="summon-source-dot"></span>
          <span>${fileName}:${escapeHtml(String(sel.sourceLocation.line))}</span>
        </div>
      `;
    } else if (sel?.sourceId) {
      const safeId = escapeHtml(sel.sourceId);
      sourceBadgeHtml = `
        <div class="summon-source-badge" title="Source ID: ${safeId}">
          <span class="summon-source-dot"></span>
          <span>Source: ${safeId}</span>
        </div>
      `;
    } else {
      sourceBadgeHtml = `
        <div class="summon-source-badge unmapped" title="No verified source mapping attached">
          <span class="summon-source-dot"></span>
          <span>DOM Element (unmapped)</span>
        </div>
      `;
    }

    // Progress section
    let progressHtml = '';
    if (task && (status === 'queued' || status === 'planning' || status === 'executing')) {
      const phase = escapeHtml(String(task.progress?.phase || status));
      const message = escapeHtml(String(task.progress?.message || (status === 'queued' ? 'Waiting for engine runner...' : 'Analyzing code and preparing fix...')));
      const percentage = task.progress?.percentage;
      const safePercentage = typeof percentage === 'number' && Number.isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : undefined;

      progressHtml = `
        <div class="summon-progress-box">
          <div class="summon-progress-header">
            <span class="summon-phase-text">${phase}</span>
            <span style="font-size: 11px; color: #94a3b8;">${safePercentage !== undefined ? `${safePercentage}%` : 'In progress'}</span>
          </div>
          <div class="summon-progress-bar-bg">
            <div class="summon-progress-bar-fill ${safePercentage === undefined ? 'indeterminate' : ''}" style="${safePercentage !== undefined ? `width: ${safePercentage}%` : ''}"></div>
          </div>
          <div class="summon-progress-msg">${message}</div>
        </div>
      `;
    }

    // Proposal review section (awaiting_approval)
    let proposalHtml = '';
    if (task && status === 'awaiting_approval' && task.proposal) {
      const edits = Array.isArray(task.proposal.edits) ? task.proposal.edits.filter(edit => edit && typeof edit === 'object') : [];
      const editItems = edits
        .map((edit) => {
          const safePath = escapeHtml(String(edit.path));
          const safeType = escapeHtml(String(edit.changeType));
          const badgeClass = escapeHtml(String(edit.changeType));
          return `
            <div class="summon-edit-item">
              <span>${safePath}</span>
              <span class="summon-edit-badge ${badgeClass}">${safeType}</span>
            </div>
            ${reviewKey ? `<div class="summon-source-review"><strong>− Removed / before (exact snippet)</strong><pre class="summon-diff-before">${escapeHtml(edit.oldContent!)}</pre><strong>+ Added / after (exact replacement)</strong><pre class="summon-diff-after">${escapeHtml(edit.newContent!)}</pre></div>` : ""}
          `;
        })
        .join('');

      const safeSummary = escapeHtml(String(task.proposal.summary || ''));
      proposalHtml = `
        <div class="summon-proposal-box">
          <div class="summon-proposal-header">
            <span>⚠️ Review Proposed Changes</span>
          </div>
          <div class="summon-proposal-summary">${safeSummary}</div>
          <div class="summon-edit-list">
            ${editItems || '<div style="font-size: 11px; color: #94a3b8;">No file edits</div>'}
          </div>
          <div class="summon-review-binding">Task ${escapeHtml(task.taskId)} · version ${escapeHtml(String(task.version))}<br>Proposal ${escapeHtml(task.proposal.proposalDigest || "missing")}</div>
          ${!reviewKey ? '<div class="summon-error-msg">This proposal cannot be reviewed accurately. Approval is disabled. Close and request a new proposal.</div>' : ""}
          <div class="summon-approval-actions">
            <button class="summon-approve-btn" id="summon-btn-approve" ${approvalDisabled ? "disabled" : ""}>Approve & Apply</button>
            <button class="summon-reject-btn" id="summon-btn-reject" ${approvalDisabled ? "disabled" : ""}>Reject</button>
          </div>
        </div>
      `;
    }

    // Success outcome section
    let successHtml = '';
    if (task && status === 'completed') {
      const safeSummary = escapeHtml(String(task.completion?.summary || 'Task completed successfully.'));
      const appliedCount = task.edits?.filter(edit => edit.status === 'applied').length || 0;
      const isPlanOnly = task.effectiveMode === 'plan';
      const ambiguous = task.completion?.type === 'edits_applied' && appliedCount === 0;
      const title = appliedCount > 0 ? (task.verification?.status === 'failed' ? 'Verification failed' : '✓ Fix Applied Successfully')
        : isPlanOnly ? '✓ Plan Generated' : '✓ Task Completed';
      const detail = appliedCount > 0
        ? task.verification?.status === 'failed' ? 'File modified, but verification failed.' : appliedCount + ' file(s) updated on disk.'
        : ambiguous ? 'File modification status is uncertain. Inspect the source before retrying.'
        : isPlanOnly ? 'Read-only plan generated. No files were modified.' : 'No edit is reported as applied.';
      successHtml = `
        <div class="summon-success-box">
          <div class="summon-success-title">${title}</div>
          <div class="summon-success-summary">${safeSummary}</div>
          <div style="font-size: 11px; color: #86efac; margin-top: 4px;">
            ${detail}
          </div>
        </div>
      `;
    }

    // Error / Disconnected section
    let errorHtml = '';
    if (this.state.connectionError) {
      errorHtml = `
        <div class="summon-error-box">
          <div class="summon-error-title">
            <span>${escapeHtml(this.errorTitle)}</span>
          </div>
          <div class="summon-error-msg">${escapeHtml(this.state.connectionError)}</div>
        </div>
      `;
    } else if (task && status === 'failed') {
      const applied = task.edits?.some(edit => edit.status === 'applied');
      const writeNotice = applied && task.verification?.status === 'failed' ? 'File modified, but verification failed.'
        : applied ? 'File modified. The task did not complete successfully.'
        : task.edits?.length && task.edits.every(edit => edit.status === 'pending' || edit.status === 'rejected')
          ? 'No edit is reported as applied.' : 'File modification status is uncertain. Inspect the source before retrying.';
      const errorMsg = escapeHtml(writeNotice + ' ' + String(task.error?.message || 'Task execution encountered an error.'));
      const errorCode = task.error?.code ? `[${escapeHtml(String(task.error.code))}] ` : '';
      errorHtml = `
        <div class="summon-error-box">
          <div class="summon-error-title">✕ Execution Failed</div>
          <div class="summon-error-msg">${errorCode}${errorMsg}</div>
        </div>
      `;
    }

    const modeFrozen = this.state.isSubmitting || !!this.state.currentTaskId;
    const isRunning = this.state.isSubmitting || status === 'queued' || status === 'planning' || status === 'executing';

    this.panelContainer.innerHTML = `
      <div class="summon-card-backdrop" id="summon-backdrop">
        <div class="summon-card" data-summon-ignore="true">
          <!-- Header -->
          <div class="summon-card-header">
            <div class="summon-header-brand">
              <div class="summon-logo-badge">⚡</div>
              <span class="summon-title">Summon Fixer</span>
              <span class="summon-status-chip ${escapeHtml(status)}">${escapeHtml(status)}</span>
            </div>
            <button class="summon-close-btn" id="summon-btn-close" title="Close [Esc]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>

          <!-- Body -->
          <div class="summon-card-body">
            <!-- Selected Element Target -->
            ${
              sel
                ? `
              <div class="summon-target-box">
                <div class="summon-target-header">
                  <span class="summon-target-label">Selected Target</span>
                  ${
                    !isRunning
                      ? `<button class="summon-reselect-btn" id="summon-btn-reselect">Change target</button>`
                      : ''
                  }
                </div>
                <div class="summon-target-element">
                  <span class="summon-tag-name">&lt;${escapeHtml(sel.tagName.toLowerCase())}&gt;</span>
                  <span class="summon-tag-text">"${escapeHtml(sel.textContent.slice(0, 40))}${sel.textContent.length > 40 ? '...' : ''}"</span>
                </div>
                ${sourceBadgeHtml}
              </div>
            `
                : ''
            }

            <!-- Instruction Input (when not completed) -->
            ${
              status !== 'completed' && status !== 'awaiting_approval'
                ? `
              <div>
                <label class="summon-field-label" for="summon-prompt-input">Instruction</label>
                <textarea
                  id="summon-prompt-input"
                  class="summon-textarea"
                  placeholder="What should Summon Fixer change or fix on this element? (e.g. 'Add a free shipping badge when cart total exceeds $100')"
                  ${isRunning ? 'disabled' : ''}
                >${escapeHtml(this.state.promptText)}</textarea>
              </div>

              <!-- Mode Selector -->
              <div class="summon-mode-selector">
                <label class="summon-field-label">Approval Mode</label>
                <div class="summon-mode-pills">
                  <button type="button" class="summon-mode-pill ${this.state.permissionMode === 'manual' ? 'selected' : ''}" data-mode="manual" ${modeFrozen ? "disabled" : ""}>
                    Manual Approval
                  </button>
                  <button type="button" class="summon-mode-pill ${this.state.permissionMode === 'plan' ? 'selected' : ''}" data-mode="plan" ${modeFrozen ? "disabled" : ""}>
                    Plan Only
                  </button>
                  <button type="button" class="summon-mode-pill disabled" data-mode="auto" disabled title="Auto Apply is disabled until runtime auto permissions are implemented" style="opacity: 0.5; cursor: not-allowed;">
                    Auto Apply (Disabled)
                  </button>
                </div>
                <span class="summon-mode-hint">
                  ${
                    this.state.permissionMode === 'manual'
                      ? 'Requires explicit review before applying any changes to your files.'
                      : this.state.permissionMode === 'plan'
                      ? 'Inspects workspace and generates diff plan without modifying disk.'
                      : 'Auto Apply is disabled until runtime auto permissions are implemented.'
                  }
                </span>
              </div>
            `
                : ''
            }

            <!-- Live Status & Progress -->
            ${progressHtml}

            <!-- Proposal Review -->
            ${proposalHtml}

            <!-- Success -->
            ${successHtml}

            <!-- Error Banner -->
            ${errorHtml}
          </div>

          <!-- Footer -->
          <div class="summon-card-footer">
            ${
              status === 'completed'
                ? `
              <button class="summon-btn summon-btn-primary" id="summon-btn-done">Done</button>
            `
                : isRunning
                ? `
              <button class="summon-btn summon-btn-secondary" id="summon-btn-close-bottom">Dismiss</button>
              <button class="summon-btn summon-btn-primary" disabled>
                <span class="summon-spinner"></span>
                <span>Working...</span>
              </button>
            `
                : status === 'awaiting_approval'
                ? `
              <button class="summon-btn summon-btn-secondary" id="summon-btn-close-bottom">Dismiss</button>
            `
                : `
              <button class="summon-btn summon-btn-secondary" id="summon-btn-close-bottom">Cancel</button>
              <button class="summon-btn summon-btn-primary" id="summon-btn-submit">
                <span>Summon Fix</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                  <polyline points="12 5 19 12 12 19"></polyline>
                </svg>
              </button>
            `
            }
          </div>
        </div>
      </div>
    `;

    // Attach DOM event listeners inside Shadow Root
    const backdrop = this.panelContainer.querySelector('#summon-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop && !isRunning) {
          this.close();
        }
      });
    }

    const closeBtn = this.panelContainer.querySelector('#summon-btn-close');
    if (closeBtn) closeBtn.addEventListener('click', () => this.close());

    const closeBottomBtn = this.panelContainer.querySelector('#summon-btn-close-bottom');
    if (closeBottomBtn) closeBottomBtn.addEventListener('click', () => this.close());

    const doneBtn = this.panelContainer.querySelector('#summon-btn-done');
    if (doneBtn) doneBtn.addEventListener('click', () => this.close());

    const reselectBtn = this.panelContainer.querySelector('#summon-btn-reselect');
    if (reselectBtn) {
      reselectBtn.addEventListener('click', () => {
        this.close();
        this.callbacks.onReselect();
      });
    }

    const textarea = this.panelContainer.querySelector('#summon-prompt-input') as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.addEventListener('input', (e) => {
        this.state.promptText = (e.target as HTMLTextAreaElement).value;
      });
      // Focus textarea automatically
      if (!isRunning && status === 'idle') {
        setTimeout(() => textarea.focus(), 50);
      }
    }

    const modePills = this.panelContainer.querySelectorAll('.summon-mode-pill');
    modePills.forEach((pill) => {
      pill.addEventListener('click', () => {
        const mode = pill.getAttribute('data-mode') as PermissionMode;
        if (!modeFrozen && (mode === 'manual' || mode === 'plan')) {
          this.state.permissionMode = mode;
          this.render();
        }
      });
    });

    const submitBtn = this.panelContainer.querySelector('#summon-btn-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => this.handleSubmit());
    }

    const approveBtn = this.panelContainer.querySelector('#summon-btn-approve');
    if (approveBtn) {
      approveBtn.addEventListener('click', () => this.handleApproval('approved', reviewKey));
    }

    const rejectBtn = this.panelContainer.querySelector('#summon-btn-reject');
    if (rejectBtn) {
      rejectBtn.addEventListener('click', () => this.handleApproval('rejected', reviewKey));
    }
  }
}
