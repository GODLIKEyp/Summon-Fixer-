import type { SelectedElementContext } from './types.js';

/**
 * Extracts concise CSS selector path for a DOM element.
 */
export function getElementSelector(el: Element): string {
  if (el.id) {
    return `#${el.id}`;
  }

  const parts: string[] = [];
  let current: Element | null = el;

  while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
    let selector = current.tagName.toLowerCase();

    if (current.id) {
      selector = `#${current.id}`;
      parts.unshift(selector);
      break;
    }

    const className = typeof current.className === 'string' ? current.className.trim() : '';
    if (className) {
      const firstClass = className.split(/\s+/)[0];
      if (firstClass && !firstClass.startsWith('summon-')) {
        selector += `.${firstClass}`;
      }
    }

    // Add sibling index if there are sibling elements with same tag
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === current?.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }

    parts.unshift(selector);
    current = current.parentElement;
    if (!current || current === document.body || current === document.documentElement) {
      break;
    }
  }

  return parts.join(' > ') || el.tagName.toLowerCase();
}

/**
 * Extracts accessible label for an element according to ARIA precedence.
 */
export function getAccessibleLabel(el: Element): string | undefined {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) {
    return ariaLabel.trim();
  }

  const ariaLabelledBy = el.getAttribute('aria-labelledby');
  if (ariaLabelledBy) {
    const ids = ariaLabelledBy.split(/\s+/);
    const labelTexts = ids
      .map((id) => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean);
    if (labelTexts.length > 0) {
      return labelTexts.join(' ');
    }
  }

  const title = el.getAttribute('title');
  if (title && title.trim()) {
    return title.trim();
  }

  const alt = el.getAttribute('alt');
  if (alt && alt.trim()) {
    return alt.trim();
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.placeholder) return el.placeholder;
    // Check if there is an associated label
    if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label?.textContent?.trim()) {
        return label.textContent.trim();
      }
    }
  }

  return undefined;
}

/**
 * Extracts verified source location from DOM element via:
 * 1. data-summon-id / data-summon-source
 *
 * The bridge verifies the ID and revision; DOM attributes alone are not authority.
 */
export function extractVerifiedSource(el: Element): {
  sourceId?: string;
  sourceRevision?: string;
  sourceLocation?: { file: string; line: number; column: number };
} {
  // 1. Check data-summon-id / data-summon-source on element or closest ancestor
  const summonIdEl = el.closest('[data-summon-id]');
  if (summonIdEl) {
    const sourceId = summonIdEl.getAttribute('data-summon-id');
    const revision = summonIdEl.getAttribute('data-summon-rev') || undefined;
    const rawLoc = summonIdEl.getAttribute('data-summon-source');

    let sourceLocation: { file: string; line: number; column: number } | undefined;
    if (rawLoc) {
      const parts = rawLoc.split(':');
      if (parts.length >= 3) {
        const line = parseInt(parts[parts.length - 2], 10);
        const column = parseInt(parts[parts.length - 1], 10);
        const file = parts.slice(0, parts.length - 2).join(':');
        if (!isNaN(line) && !isNaN(column) && file) {
          sourceLocation = { file, line, column };
        }
      }
    }

    if (sourceId) {
      return {
        sourceId,
        sourceRevision: revision,
        sourceLocation,
      };
    }
  }

  // No verified source mapping available
  return {};
}

/**
 * Builds rich, structured context from an inspected DOM element.
 */
export function inspectElement(el: Element): SelectedElementContext {
  const tagName = el.tagName.toUpperCase();

  // Extract clean text content (up to 200 chars)
  let text = '';
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    text = el.value || el.placeholder || '';
  } else {
    text = el.textContent || '';
  }
  text = text.replace(/\s+/g, ' ').trim().slice(0, 200);

  const accessibleLabel = getAccessibleLabel(el);
  const elementSelector = getElementSelector(el);

  // Extract relevant attributes
  const attributes: Record<string, string> = {};
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i];
    if (
      attr.name === 'id' ||
      attr.name === 'class' ||
      attr.name === 'name' ||
      attr.name === 'type' ||
      attr.name === 'href' ||
      attr.name.startsWith('data-') ||
      attr.name.startsWith('aria-') ||
      attr.name === 'role'
    ) {
      if (!attr.name.startsWith('data-summon-')) {
        attributes[attr.name] = attr.value.slice(0, 200);
      }
    }
  }

  const role = el.getAttribute('role') || undefined;

  // Surrounding DOM context
  const parent = el.parentElement;
  let surroundingContext = '';
  if (parent) {
    const parentTag = parent.tagName.toLowerCase();
    const parentClasses = typeof parent.className === 'string' ? parent.className.trim() : '';
    surroundingContext = `Parent: <${parentTag}${parentClasses ? ` class="${parentClasses}"` : ''}>`;
    if (parent.children.length > 1) {
      const siblings = Array.from(parent.children)
        .slice(0, 5)
        .map((c) => c.tagName.toLowerCase());
      surroundingContext += ` | Siblings: [${siblings.join(', ')}]`;
    }
  }

  // Verified source location
  const sourceInfo = extractVerifiedSource(el);

  return {
    element: el,
    tagName,
    textContent: text,
    accessibleLabel,
    role,
    elementSelector,
    attributes,
    surroundingContext,
    sourceId: sourceInfo.sourceId,
    sourceRevision: sourceInfo.sourceRevision,
    sourceLocation: sourceInfo.sourceLocation,
  };
}
