import { OVERLAY_STYLES } from './styles.js';
import { PointModeController } from './point-mode.js';
import { PromptPanelController } from './prompt-panel.js';
import { inspectElement } from './inspector.js';
import { SummonApiClient } from './client-api.js';
import type { OverlayConfig } from './types.js';

export * from './types.js';
export { SummonApiClient } from './client-api.js';
export { inspectElement } from './inspector.js';
export { PointModeController } from './point-mode.js';
export { PromptPanelController } from './prompt-panel.js';

declare global {
  interface Window {
    __SUMMON_OVERLAY_MOUNTED__?: boolean;
    __SUMMON_OVERLAY_INSTANCE__?: SummonOverlay;
  }
}

const BaseElement =
  typeof HTMLElement !== 'undefined'
    ? HTMLElement
    : (class {} as unknown as typeof HTMLElement);

/**
 * Custom Web Component hosting the isolated Summon Fixer visual companion.
 */
export class SummonOverlay extends BaseElement {
  private shadow: ShadowRoot;
  private pointModeController!: PointModeController;
  private promptPanelController!: PromptPanelController;
  private apiClient!: SummonApiClient;
  private launcherBtn!: HTMLElement;
  private config: OverlayConfig = {};

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
  }

  disconnectedCallback(): void {
    this.cleanup();
  }

  public init(config: OverlayConfig = {}): void {
    this.config = config;
    this.apiClient = new SummonApiClient({ apiPrefix: config.apiPrefix });
    this.setupControllers();
  }

  public togglePointMode(): void {
    this.pointModeController?.toggle();
  }

  private cleanup(): void {
    this.pointModeController?.destroy();
    this.promptPanelController?.destroy();
  }

  private render(): void {
    // Inject self-contained styles into Shadow Root
    const styleEl = document.createElement('style');
    styleEl.textContent = OVERLAY_STYLES;
    this.shadow.appendChild(styleEl);

    // Root wrapper
    const rootEl = document.createElement('div');
    rootEl.className = 'summon-root';
    rootEl.setAttribute('data-summon-ignore', 'true');

    // 1. Highlighter box for Point Mode
    const highlighterEl = document.createElement('div');
    highlighterEl.className = 'summon-highlighter';

    const highlightTagEl = document.createElement('div');
    highlightTagEl.className = 'summon-highlight-tag';
    highlightTagEl.textContent = '<element>';
    highlighterEl.appendChild(highlightTagEl);
    rootEl.appendChild(highlighterEl);

    // 2. Panel container for Floating Prompt
    const panelContainerEl = document.createElement('div');
    panelContainerEl.className = 'summon-panel-container';
    rootEl.appendChild(panelContainerEl);

    // 3. Floating launcher pill at bottom-right
    const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
    const shortcutLabel = isMac ? '⌘⇧S' : 'Ctrl+Shift+S';

    this.launcherBtn = document.createElement('div');
    this.launcherBtn.className = 'summon-launcher';
    this.launcherBtn.title = `Toggle Summon Fixer Point Mode (${shortcutLabel})`;
    this.launcherBtn.innerHTML = `
      <div class="summon-launcher-icon">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
        </svg>
      </div>
      <span class="summon-launcher-text">Summon Fixer</span>
      <span class="summon-launcher-badge">${shortcutLabel}</span>
    `;

    this.launcherBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePointMode();
    });

    rootEl.appendChild(this.launcherBtn);
    this.shadow.appendChild(rootEl);

    this.init(this.config);
  }

  private setupControllers(): void {
    const highlighterEl = this.shadow.querySelector('.summon-highlighter') as HTMLElement;
    const highlightTagEl = this.shadow.querySelector('.summon-highlight-tag') as HTMLElement;
    const panelContainerEl = this.shadow.querySelector('.summon-panel-container') as HTMLElement;

    if (!highlighterEl || !highlightTagEl || !panelContainerEl) return;

    // Cleanup previous if re-initializing
    this.cleanup();

    // 1. Prompt Panel Controller
    this.promptPanelController = new PromptPanelController(
      panelContainerEl,
      this.apiClient,
      {
        onClose: () => {
          // Panel closed
        },
        onReselect: () => {
          this.pointModeController.activate();
        },
      }
    );

    // 2. Point Mode Controller
    this.pointModeController = new PointModeController(
      highlighterEl,
      highlightTagEl,
      this,
      {
        onSelect: (selectedEl) => {
          const inspected = inspectElement(selectedEl);
          this.promptPanelController.open(inspected);
        },
        onActivate: () => {
          this.launcherBtn?.classList.add('active-mode');
        },
        onDeactivate: () => {
          this.launcherBtn?.classList.remove('active-mode');
        },
      }
    );
  }
}

/**
 * Initializes and mounts the Summon Fixer overlay into the page.
 * Guards against duplicate mounting on hot module reload (HMR).
 */
export function initOverlay(config: OverlayConfig = {}): SummonOverlay | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }

  // Define custom element if not already registered
  if (!customElements.get('summon-overlay')) {
    customElements.define('summon-overlay', SummonOverlay);
  }

  // Remove existing overlay if present (HMR clean replacement)
  const existing = document.querySelector('summon-overlay');
  if (existing) {
    existing.remove();
  }

  const overlay = document.createElement('summon-overlay') as SummonOverlay;
  overlay.setAttribute('data-summon-ignore', 'true');
  document.body.appendChild(overlay);

  overlay.init(config);
  window.__SUMMON_OVERLAY_MOUNTED__ = true;
  window.__SUMMON_OVERLAY_INSTANCE__ = overlay;

  return overlay;
}

// Auto-mount in browser if document is ready or on DOMContentLoaded
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (!window.__SUMMON_OVERLAY_MOUNTED__) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => initOverlay());
    } else {
      initOverlay();
    }
  }
}
