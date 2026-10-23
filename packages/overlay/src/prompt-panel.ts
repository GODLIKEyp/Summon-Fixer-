import type {
  TaskRequest,
  TaskState,
  PermissionMode,
  EditApprovalResponse,
} from '@summon-fixer/contracts';
import type { SelectedElementContext, OverlayState } from './types.js';
import { SummonApiClient } from './client-api.js';

export interface PromptPanelCallbacks {
  onClose: () => void;
  onReselect: () => void;
  onStateChange?: (state: OverlayState) => void;
}

export class PromptPanelController {
  private panelContainer: HTMLElement;
  private apiClient: SummonApiClient;
  private callbacks: PromptPanelCallbacks;
  private pollIntervalId: number | null = null;

  private state: OverlayState = {
    pointModeActive: false,
    selectedElement: null,
    panelOpen: false,
    promptText: '',
    permissionMode: 'manual', // Start with manual approval mode as required
    currentTaskId: null,
    currentTaskState: null,
    isSubmitting: false,
    isPolling: false,
    engineConnected: true,
    connectionError: null,
  };

  constructor(
    panelContainer: HTMLElement,
    apiClient: SummonApiClient,
    callbacks: PromptPanelCallbacks
  ) {
    this.panelContainer = panelContainer;
    this.apiClient = apiClient;
    this.callbacks = callbacks;
  }

  public getState(): OverlayState {
    return { ...this.state };
  }

  public open(selectedElement: SelectedElementContext): void {
    this.state.selectedElement = selectedElement;
    this.state.panelOpen = true;
    this.state.connectionError = null;
    this.render();
  }

  public close(): void {
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
    this.stopPolling();
    this.panelContainer.innerHTML = '';
  }

  private stopPolling(): void {
    if (this.pollIntervalId !== null) {
      window.clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    this.state.isPolling = false;
  }

  private startPolling(taskId: string): void {
    this.stopPolling();
    this.state.isPolling = true;

    // Immediate first fetch
    this.pollTask(taskId);

    // Poll every 700ms
    this.pollIntervalId = window.setInterval(() => {
      this.pollTask(taskId);
    }, 700);
  }

  private async pollTask(taskId: string): Promise<void> {
    try {
      const taskState = await this.apiClient.getTask(taskId);
      this.state.currentTaskState = taskState;
      this.state.connectionError = null;
      this.state.engineConnected = true;

      // Check if terminal
      const status = taskState.status;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        this.stopPolling();
      }

      this.render();
    } catch (err) {
      // Disconnected or connection error
      const msg = err instanceof Error ? err.message : 'Connection failed';
      this.state.connectionError = `Engine disconnected: ${msg}. Verify that the Summon Fixer loopback engine is running.`;
      this.state.engineConnected = false;
      this.stopPolling();
      this.render();
    }
  }

  private async handleSubmit(): Promise<void> {
    const prompt = this.state.promptText.trim();
    if (!prompt) {
      alert('Please enter an instruction for Summon Fixer.');
      return;
    }

    const sel = this.state.selectedElement;
    if (!sel) return;

    this.state.isSubmitting = true;
    this.state.connectionError = null;
    this.render();

    const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;

    const taskRequest: TaskRequest = {
      requestId,
      prompt,
      requestedMode: this.state.permissionMode,
      priority: 'normal',
      createdAt: new Date().toISOString(),
      context: {
        relevantFiles: [],
        ui: {
          componentName: sel.tagName,
          elementSelector: sel.elementSelector,
          renderedUrl: window.location.href,
        },
        sourceSelection: sel.sourceId
          ? {
              sourceId: sel.sourceId,
              revision: sel.sourceRevision,
              description: sel.sourceLocation
                ? `${sel.sourceLocation.file}:${sel.sourceLocation.line}`
                : undefined,
            }
          : undefined,
        activeFile: sel.sourceLocation
          ? {
              path: sel.sourceLocation.file,
              sourceId: sel.sourceId,
              revision: sel.sourceRevision,
              lineRange: {
                start: sel.sourceLocation.line,
                end: sel.sourceLocation.line,
              },
            }
          : undefined,
        client: {
          clientType: 'overlay',
          clientVersion: '0.1.0',
        },
        metadata: {
          elementContext: {
            tagName: sel.tagName,
            textContent: sel.textContent,
            accessibleLabel: sel.accessibleLabel,
            attributes: sel.attributes,
            surroundingContext: sel.surroundingContext,
          },
        },
      },
    };

    try {
      const res = await this.apiClient.createTask(taskRequest);
      this.state.isSubmitting = false;
      this.state.currentTaskId = res.taskId;
      if (res.state) {
        this.state.currentTaskState = res.state;
      }
      this.render();
      this.startPolling(res.taskId);
    } catch (err) {
      this.state.isSubmitting = false;
      const msg = err instanceof Error ? err.message : 'Submission failed';
      this.state.connectionError = `Failed to submit task to engine: ${msg}. Make sure the Summon Fixer engine daemon is active on localhost.`;
      this.state.engineConnected = false;
      this.render();
    }
  }

  private async handleApproval(decision: 'approved' | 'rejected'): Promise<void> {
    const task = this.state.currentTaskState;
    if (!task || !task.proposal) return;

    this.state.isSubmitting = true;
    this.render();

    const approvalResponse: EditApprovalResponse = {
      taskId: task.taskId,
      taskVersion: task.version,
      proposalDigest: task.proposal.proposalDigest || '',
      decision,
      respondedAt: new Date().toISOString(),
    };

    try {
      await this.apiClient.submitApproval(task.taskId, approvalResponse);
      this.state.isSubmitting = false;
      this.render();
      this.startPolling(task.taskId);
    } catch (err) {
      this.state.isSubmitting = false;
      const msg = err instanceof Error ? err.message : 'Approval failed';
      this.state.connectionError = `Failed to submit approval: ${msg}`;
      this.render();
    }
  }

  private async handleCancel(): Promise<void> {
    if (!this.state.currentTaskId) return;
    try {
      await this.apiClient.cancelTask(this.state.currentTaskId);
      this.stopPolling();
      this.close();
    } catch {
      this.stopPolling();
      this.close();
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

    let sourceBadgeHtml = '';
    if (sel?.sourceLocation) {
      const fileName = sel.sourceLocation.file.split('/').pop() || sel.sourceLocation.file;
      sourceBadgeHtml = `
        <div class="summon-source-badge" title="${sel.sourceLocation.file}:${sel.sourceLocation.line}">
          <span class="summon-source-dot"></span>
          <span>${fileName}:${sel.sourceLocation.line}</span>
        </div>
      `;
    } else if (sel?.sourceId) {
      sourceBadgeHtml = `
        <div class="summon-source-badge" title="Source ID: ${sel.sourceId}">
          <span class="summon-source-dot"></span>
          <span>Source: ${sel.sourceId}</span>
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
      const phase = task.progress?.phase || status;
      const message = task.progress?.message || (status === 'queued' ? 'Waiting for engine runner...' : 'Analyzing code and preparing fix...');
      const percentage = task.progress?.percentage;

      progressHtml = `
        <div class="summon-progress-box">
          <div class="summon-progress-header">
            <span class="summon-phase-text">${phase}</span>
            <span style="font-size: 11px; color: #94a3b8;">${percentage !== undefined ? `${percentage}%` : 'In progress'}</span>
          </div>
          <div class="summon-progress-bar-bg">
            <div class="summon-progress-bar-fill ${percentage === undefined ? 'indeterminate' : ''}" style="${percentage !== undefined ? `width: ${percentage}%` : ''}"></div>
          </div>
          <div class="summon-progress-msg">${message}</div>
        </div>
      `;
    }

    // Proposal review section (awaiting_approval)
    let proposalHtml = '';
    if (task && status === 'awaiting_approval' && task.proposal) {
      const edits = task.proposal.edits || [];
      const editItems = edits
        .map((edit) => {
          const badgeClass = edit.changeType;
          return `
            <div class="summon-edit-item">
              <span>${edit.path}</span>
              <span class="summon-edit-badge ${badgeClass}">${edit.changeType}</span>
            </div>
          `;
        })
        .join('');

      proposalHtml = `
        <div class="summon-proposal-box">
          <div class="summon-proposal-header">
            <span>⚠️ Review Proposed Changes</span>
          </div>
          <div class="summon-proposal-summary">${task.proposal.summary}</div>
          <div class="summon-edit-list">
            ${editItems || '<div style="font-size: 11px; color: #94a3b8;">No file edits</div>'}
          </div>
          <div class="summon-approval-actions">
            <button class="summon-approve-btn" id="summon-btn-approve">Approve & Apply</button>
            <button class="summon-reject-btn" id="summon-btn-reject">Reject</button>
          </div>
        </div>
      `;
    }

    // Success outcome section
    let successHtml = '';
    if (task && status === 'completed') {
      const summary = task.completion?.summary || 'Task completed successfully.';
      const appliedCount = task.completion?.appliedEditsCount || task.edits.length || 0;
      successHtml = `
        <div class="summon-success-box">
          <div class="summon-success-title">✓ Fix Applied Successfully</div>
          <div class="summon-success-summary">${summary}</div>
          <div style="font-size: 11px; color: #86efac; margin-top: 4px;">
            ${appliedCount > 0 ? `${appliedCount} file(s) updated on disk.` : 'Read-only plan generated.'}
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
            <span>⚡ Connection Notice</span>
          </div>
          <div class="summon-error-msg">${this.state.connectionError}</div>
        </div>
      `;
    } else if (task && status === 'failed') {
      const errorMsg = task.error?.message || 'Task execution encountered an error.';
      const errorCode = task.error?.code ? `[${task.error.code}] ` : '';
      errorHtml = `
        <div class="summon-error-box">
          <div class="summon-error-title">✕ Execution Failed</div>
          <div class="summon-error-msg">${errorCode}${errorMsg}</div>
        </div>
      `;
    }

    const isRunning = this.state.isSubmitting || status === 'queued' || status === 'planning' || status === 'executing';

    this.panelContainer.innerHTML = `
      <div class="summon-card-backdrop" id="summon-backdrop">
        <div class="summon-card" data-summon-ignore="true">
          <!-- Header -->
          <div class="summon-card-header">
            <div class="summon-header-brand">
              <div class="summon-logo-badge">⚡</div>
              <span class="summon-title">Summon Fixer</span>
              <span class="summon-status-chip ${status}">${status}</span>
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
                  <span class="summon-tag-name">&lt;${sel.tagName.toLowerCase()}&gt;</span>
                  <span class="summon-tag-text">"${sel.textContent.slice(0, 40)}${sel.textContent.length > 40 ? '...' : ''}"</span>
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
                >${this.state.promptText}</textarea>
              </div>

              <!-- Mode Selector -->
              <div class="summon-mode-selector">
                <label class="summon-field-label">Approval Mode</label>
                <div class="summon-mode-pills">
                  <button type="button" class="summon-mode-pill ${this.state.permissionMode === 'manual' ? 'selected' : ''}" data-mode="manual">
                    Manual Approval
                  </button>
                  <button type="button" class="summon-mode-pill ${this.state.permissionMode === 'plan' ? 'selected' : ''}" data-mode="plan">
                    Plan Only
                  </button>
                  <button type="button" class="summon-mode-pill ${this.state.permissionMode === 'auto' ? 'selected' : ''}" data-mode="auto">
                    Auto Apply
                  </button>
                </div>
                <span class="summon-mode-hint">
                  ${
                    this.state.permissionMode === 'manual'
                      ? 'Requires explicit review before applying any changes to your files.'
                      : this.state.permissionMode === 'plan'
                      ? 'Inspects workspace and generates diff plan without modifying disk.'
                      : 'Applies verified changes automatically within policy limits.'
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
              <button class="summon-btn summon-btn-secondary" id="summon-btn-cancel-task">Cancel Task</button>
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
        if (mode) {
          this.state.permissionMode = mode;
          this.render();
        }
      });
    });

    const submitBtn = this.panelContainer.querySelector('#summon-btn-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => this.handleSubmit());
    }

    const cancelTaskBtn = this.panelContainer.querySelector('#summon-btn-cancel-task');
    if (cancelTaskBtn) {
      cancelTaskBtn.addEventListener('click', () => this.handleCancel());
    }

    const approveBtn = this.panelContainer.querySelector('#summon-btn-approve');
    if (approveBtn) {
      approveBtn.addEventListener('click', () => this.handleApproval('approved'));
    }

    const rejectBtn = this.panelContainer.querySelector('#summon-btn-reject');
    if (rejectBtn) {
      rejectBtn.addEventListener('click', () => this.handleApproval('rejected'));
    }
  }
}
