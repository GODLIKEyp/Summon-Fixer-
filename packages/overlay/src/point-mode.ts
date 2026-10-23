export interface PointModeCallbacks {
  onSelect: (element: Element) => void;
  onActivate?: () => void;
  onDeactivate?: () => void;
}

export class PointModeController {
  private active = false;
  private hoveredElement: Element | null = null;
  private highlighterEl: HTMLElement;
  private highlightTagEl: HTMLElement;
  private callbacks: PointModeCallbacks;
  private overlayRoot: HTMLElement;

  constructor(
    highlighterEl: HTMLElement,
    highlightTagEl: HTMLElement,
    overlayRoot: HTMLElement,
    callbacks: PointModeCallbacks
  ) {
    this.highlighterEl = highlighterEl;
    this.highlightTagEl = highlightTagEl;
    this.overlayRoot = overlayRoot;
    this.callbacks = callbacks;

    this.onKeyDown = this.onKeyDown.bind(this);
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onClick = this.onClick.bind(this);
    this.onScroll = this.onScroll.bind(this);

    // Register global keyboard shortcut listener
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
  }

  public isActive(): boolean {
    return this.active;
  }

  public activate(): void {
    if (this.active) return;
    this.active = true;
    this.highlighterEl.classList.add('active');

    window.addEventListener('mousemove', this.onMouseMove, { passive: true, capture: true });
    window.addEventListener('click', this.onClick, { capture: true });
    window.addEventListener('scroll', this.onScroll, { passive: true, capture: true });

    this.callbacks.onActivate?.();
  }

  public deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.hoveredElement = null;
    this.highlighterEl.classList.remove('active');

    window.removeEventListener('mousemove', this.onMouseMove, { capture: true });
    window.removeEventListener('click', this.onClick, { capture: true });
    window.removeEventListener('scroll', this.onScroll, { capture: true });

    this.callbacks.onDeactivate?.();
  }

  public toggle(): void {
    if (this.active) {
      this.deactivate();
    } else {
      this.activate();
    }
  }

  public destroy(): void {
    this.deactivate();
    window.removeEventListener('keydown', this.onKeyDown, { capture: true });
  }

  private onKeyDown(e: KeyboardEvent): void {
    // 1. Shortcut: Cmd+Shift+S (macOS) or Ctrl+Shift+S (Windows/Linux) or Alt+Shift+S fallback
    const key = e.key.toLowerCase();
    const isPrimaryShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && key === 's';
    const isFallbackShortcut = e.altKey && e.shiftKey && key === 's';

    if (isPrimaryShortcut || isFallbackShortcut) {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
      return;
    }

    // 2. Escape cancels selection mode
    if (e.key === 'Escape' && this.active) {
      e.preventDefault();
      e.stopPropagation();
      this.deactivate();
    }
  }

  private isIgnoredElement(el: Element | null): boolean {
    if (!el) return true;
    if (el === document.documentElement || el === document.body) return true;
    if (el === this.overlayRoot || this.overlayRoot.contains(el)) return true;
    if (el.closest('summon-overlay') || el.closest('[data-summon-ignore]')) return true;
    return false;
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.active) return;

    // Use elementFromPoint to find the element under cursor
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (this.isIgnoredElement(target)) {
      this.highlighterEl.style.display = 'none';
      this.hoveredElement = null;
      return;
    }

    if (target === this.hoveredElement) {
      return;
    }

    this.hoveredElement = target;
    this.updateHighlight(target!);
  }

  private onScroll(): void {
    if (!this.active || !this.hoveredElement) return;
    this.updateHighlight(this.hoveredElement);
  }

  private updateHighlight(el: Element): void {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.highlighterEl.style.display = 'none';
      return;
    }

    this.highlighterEl.style.display = 'block';
    this.highlighterEl.style.top = `${rect.top}px`;
    this.highlighterEl.style.left = `${rect.left}px`;
    this.highlighterEl.style.width = `${rect.width}px`;
    this.highlighterEl.style.height = `${rect.height}px`;

    // Tag text formatting
    const tag = el.tagName.toLowerCase();
    const className = typeof el.className === 'string' ? el.className.trim() : '';
    const firstClass = className ? `.${className.split(/\s+/)[0]}` : '';

    const sourceId = el.getAttribute('data-summon-id');
    const sourceLoc = el.getAttribute('data-summon-source');
    let extra = '';
    if (sourceLoc) {
      const parts = sourceLoc.split('/');
      extra = ` [${parts[parts.length - 1]}]`;
    } else if (sourceId) {
      extra = ` [${sourceId}]`;
    }

    this.highlightTagEl.textContent = `<${tag}${firstClass}>${extra}`;

    // Position tag pill above or below element
    if (rect.top < 30) {
      this.highlightTagEl.style.top = `${rect.height + 4}px`;
    } else {
      this.highlightTagEl.style.top = '-26px';
    }
  }

  private onClick(e: MouseEvent): void {
    if (!this.active) return;

    // Check if click was inside overlay UI itself (e.g. toggle pill)
    const path = e.composedPath();
    if (path.includes(this.overlayRoot)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const target = this.hoveredElement || document.elementFromPoint(e.clientX, e.clientY);
    if (!this.isIgnoredElement(target)) {
      const selected = target!;
      this.deactivate();
      this.callbacks.onSelect(selected);
    } else {
      this.deactivate();
    }
  }
}
