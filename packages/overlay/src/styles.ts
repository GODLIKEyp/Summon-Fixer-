/**
 * Isolated styles injected exclusively inside the Summon Fixer Shadow Root.
 * Guaranteed zero styling leakage into or out of the host web page.
 */
export const OVERLAY_STYLES = `
:host {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: #f1f5f9;
  z-index: 2147483645;
  pointer-events: none;
}

*, *::before, *::after {
  box-sizing: border-box;
}

/* -------------------------------------------------------------
   HIGHLIGHTER & HOVER TARGETING (Point Mode)
------------------------------------------------------------- */
.summon-highlighter {
  position: fixed;
  display: none;
  pointer-events: none;
  border: 2px solid #6366f1;
  background-color: rgba(99, 102, 241, 0.14);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.3), 0 4px 16px rgba(99, 102, 241, 0.35);
  border-radius: 4px;
  z-index: 2147483646;
  transition: top 0.05s ease-out, left 0.05s ease-out, width 0.05s ease-out, height 0.05s ease-out;
}

.summon-highlighter.active {
  display: block;
}

.summon-highlight-tag {
  position: absolute;
  top: -26px;
  left: 0;
  background: #4f46e5;
  color: #ffffff;
  font-size: 11px;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  padding: 2px 8px;
  border-radius: 4px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
  white-space: nowrap;
  pointer-events: none;
}

/* -------------------------------------------------------------
   FLOATING TOGGLE PILL (Bottom-Right Quick Launcher)
------------------------------------------------------------- */
.summon-launcher {
  position: fixed;
  bottom: 18px;
  right: 18px;
  pointer-events: auto;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  gap: 8px;
  background: #0f172a;
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #f8fafc;
  padding: 8px 14px;
  border-radius: 9999px;
  cursor: pointer;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(99, 102, 241, 0.2);
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  user-select: none;
}

.summon-launcher:hover {
  background: #1e293b;
  border-color: #6366f1;
  transform: translateY(-2px);
  box-shadow: 0 8px 25px rgba(0, 0, 0, 0.5), 0 0 12px rgba(99, 102, 241, 0.4);
}

.summon-launcher.active-mode {
  background: #4338ca;
  border-color: #a5b4fc;
  box-shadow: 0 0 16px rgba(99, 102, 241, 0.6);
}

.summon-launcher-icon {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #818cf8;
}

.summon-launcher.active-mode .summon-launcher-icon {
  color: #ffffff;
}

.summon-launcher-text {
  font-weight: 600;
  font-size: 13px;
  letter-spacing: -0.01em;
}

.summon-launcher-badge {
  background: rgba(255, 255, 255, 0.12);
  color: #94a3b8;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  margin-left: 2px;
}

/* -------------------------------------------------------------
   FLOATING PROMPT CARD / INSPECTION PANEL
------------------------------------------------------------- */
.summon-card-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.4);
  backdrop-filter: blur(2px);
  pointer-events: auto;
  z-index: 2147483647;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  padding: 24px;
}

.summon-card {
  width: 440px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 48px);
  background: #0f172a;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(99, 102, 241, 0.25);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  pointer-events: auto;
  animation: summonSlideUp 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes summonSlideUp {
  from {
    opacity: 0;
    transform: translateY(16px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* Card Header */
.summon-card-header {
  padding: 14px 18px;
  background: #1e293b;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.summon-header-brand {
  display: flex;
  align-items: center;
  gap: 8px;
}

.summon-logo-badge {
  background: linear-gradient(135deg, #6366f1, #a855f7);
  width: 22px;
  height: 22px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  font-size: 12px;
  color: #ffffff;
}

.summon-title {
  font-weight: 600;
  font-size: 14px;
  color: #f8fafc;
}

.summon-status-chip {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 9999px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.summon-status-chip.idle {
  background: rgba(148, 163, 184, 0.15);
  color: #94a3b8;
}

.summon-status-chip.queued,
.summon-status-chip.planning,
.summon-status-chip.executing {
  background: rgba(99, 102, 241, 0.2);
  color: #818cf8;
}

.summon-status-chip.awaiting_approval {
  background: rgba(245, 158, 11, 0.2);
  color: #fbbf24;
}

.summon-status-chip.completed {
  background: rgba(34, 197, 94, 0.2);
  color: #4ade80;
}

.summon-status-chip.failed {
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
}

.summon-close-btn {
  background: transparent;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.summon-close-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
}

/* Card Body */
.summon-card-body {
  padding: 16px 18px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 480px;
}

/* Selected Element Target Box */
.summon-target-box {
  background: #1e293b;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.summon-target-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.summon-target-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: #94a3b8;
  letter-spacing: 0.04em;
}

.summon-reselect-btn {
  background: transparent;
  border: none;
  color: #818cf8;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  padding: 0;
}

.summon-reselect-btn:hover {
  text-decoration: underline;
  color: #a5b4fc;
}

.summon-target-element {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  word-break: break-all;
}

.summon-tag-name {
  color: #ec4899;
  font-weight: 600;
}

.summon-tag-text {
  color: #cbd5e1;
  font-style: italic;
}

.summon-source-badge {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #38bdf8;
  background: rgba(56, 189, 248, 0.1);
  padding: 3px 8px;
  border-radius: 4px;
  width: fit-content;
  font-family: ui-monospace, SFMono-Regular, monospace;
}

.summon-source-badge.unmapped {
  color: #94a3b8;
  background: rgba(148, 163, 184, 0.1);
}

.summon-source-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #38bdf8;
}

.summon-source-badge.unmapped .summon-source-dot {
  background: #94a3b8;
}

/* Prompt Input */
.summon-field-label {
  font-size: 12px;
  font-weight: 600;
  color: #cbd5e1;
  margin-bottom: 4px;
}

.summon-textarea {
  width: 100%;
  height: 90px;
  background: #020617;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #f8fafc;
  padding: 10px 12px;
  font-family: inherit;
  font-size: 13px;
  resize: vertical;
  outline: none;
  transition: border-color 0.15s ease;
}

.summon-textarea:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);
}

.summon-textarea::placeholder {
  color: #64748b;
}

/* Mode Selector */
.summon-mode-selector {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.summon-mode-pills {
  display: flex;
  background: #020617;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 2px;
  gap: 2px;
}

.summon-mode-pill {
  flex: 1;
  background: transparent;
  border: none;
  color: #94a3b8;
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  text-align: center;
  transition: all 0.15s ease;
}

.summon-mode-pill:hover {
  color: #f1f5f9;
}

.summon-mode-pill.selected {
  background: #4f46e5;
  color: #ffffff;
  font-weight: 600;
}

.summon-mode-hint {
  font-size: 11px;
  color: #64748b;
}

/* Progress / Status Block */
.summon-progress-box {
  background: #1e293b;
  border: 1px solid rgba(99, 102, 241, 0.2);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.summon-progress-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.summon-phase-text {
  font-size: 12px;
  font-weight: 600;
  color: #818cf8;
  text-transform: capitalize;
}

.summon-progress-bar-bg {
  height: 4px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
  overflow: hidden;
}

.summon-progress-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #6366f1, #a855f7);
  width: 0%;
  transition: width 0.3s ease;
}

.summon-progress-bar-fill.indeterminate {
  width: 40%;
  animation: summonIndeterminate 1.4s infinite ease-in-out;
}

@keyframes summonIndeterminate {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(350%); }
}

.summon-progress-msg {
  font-size: 12px;
  color: #cbd5e1;
}

/* Proposal Review / Approval Box */
.summon-proposal-box {
  background: #1e293b;
  border: 1px solid #f59e0b;
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.summon-proposal-header {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #fbbf24;
  font-weight: 600;
  font-size: 13px;
}

.summon-proposal-summary {
  font-size: 12px;
  color: #f1f5f9;
}

.summon-edit-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 150px;
  overflow-y: auto;
}

.summon-edit-item {
  background: #020617;
  padding: 6px 8px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.summon-edit-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 3px;
  text-transform: uppercase;
}

.summon-edit-badge.update {
  background: rgba(56, 189, 248, 0.2);
  color: #38bdf8;
}

.summon-edit-badge.create {
  background: rgba(34, 197, 94, 0.2);
  color: #4ade80;
}

.summon-edit-badge.delete {
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
}

.summon-approval-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.summon-approve-btn {
  flex: 1;
  background: #16a34a;
  color: #ffffff;
  border: none;
  padding: 8px 12px;
  border-radius: 6px;
  font-weight: 600;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.summon-approve-btn:hover {
  background: #15803d;
}

.summon-reject-btn {
  flex: 1;
  background: rgba(255, 255, 255, 0.1);
  color: #cbd5e1;
  border: none;
  padding: 8px 12px;
  border-radius: 6px;
  font-weight: 500;
  font-size: 12px;
  cursor: pointer;
}

.summon-reject-btn:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #ffffff;
}

/* Error / Disconnected Banner */
.summon-error-box {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid #ef4444;
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.summon-error-title {
  color: #f87171;
  font-weight: 600;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.summon-error-msg {
  color: #fca5a5;
  font-size: 12px;
  line-height: 1.4;
}

/* Success Banner */
.summon-success-box {
  background: rgba(34, 197, 94, 0.15);
  border: 1px solid #22c55e;
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.summon-success-title {
  color: #4ade80;
  font-weight: 600;
  font-size: 13px;
}

.summon-success-summary {
  color: #bbf7d0;
  font-size: 12px;
}

/* Card Footer Controls */
.summon-card-footer {
  padding: 12px 18px;
  background: #1e293b;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.summon-btn {
  padding: 8px 14px;
  border-radius: 6px;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  border: none;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: all 0.15s ease;
}

.summon-btn-secondary {
  background: rgba(255, 255, 255, 0.08);
  color: #cbd5e1;
}

.summon-btn-secondary:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #ffffff;
}

.summon-btn-primary {
  background: #4f46e5;
  color: #ffffff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}

.summon-btn-primary:hover:not(:disabled) {
  background: #4338ca;
  box-shadow: 0 0 10px rgba(99, 102, 241, 0.5);
}

.summon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.summon-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #ffffff;
  border-radius: 50%;
  animation: summonSpin 0.7s linear infinite;
}

@keyframes summonSpin {
  to { transform: rotate(360deg); }
}
`;
