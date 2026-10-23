export class MockNode {
  static readonly ELEMENT_NODE = 1;
  public nodeType: number = 1;
}

export class MockElement extends MockNode {
  public tagName: string;
  public id: string = '';
  public className: string = '';
  public textContent: string = '';
  public value?: string;
  public placeholder?: string;
  public attributes: Array<{ name: string; value: string }> = [];
  public parentElement: MockElement | null = null;
  public children: MockElement[] = [];

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  public getAttribute(name: string): string | null {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    const attr = this.attributes.find((a) => a.name === name);
    return attr ? attr.value : null;
  }

  public setAttribute(name: string, value: string): void {
    if (name === 'id') this.id = value;
    if (name === 'class') this.className = value;
    const existing = this.attributes.find((a) => a.name === name);
    if (existing) {
      existing.value = value;
    } else {
      this.attributes.push({ name, value });
    }
  }

  public appendChild(child: MockElement): void {
    child.parentElement = this;
    this.children.push(child);
  }

  public closest(selector: string): MockElement | null {
    let current: MockElement | null = this;
    while (current) {
      if (selector.startsWith('[') && selector.endsWith(']')) {
        const attrName = selector.slice(1, -1);
        if (current.getAttribute(attrName) !== null) {
          return current;
        }
      }
      current = current.parentElement;
    }
    return null;
  }
}

export class MockHTMLElement extends MockElement {}
export class MockHTMLInputElement extends MockHTMLElement {}
export class MockHTMLTextAreaElement extends MockHTMLElement {}

export function setupTestDom() {
  const elementsById = new Map<string, MockElement>();

  const mockDocument = {
    createElement(tagName: string): MockElement {
      return new MockElement(tagName);
    },
    getElementById(id: string): MockElement | null {
      return elementsById.get(id) || null;
    },
    querySelector(): MockElement | null {
      return null;
    },
    body: new MockElement('BODY'),
    documentElement: new MockElement('HTML'),
  };

  (globalThis as any).Node = MockNode;
  (globalThis as any).Element = MockElement;
  (globalThis as any).HTMLElement = MockHTMLElement;
  (globalThis as any).HTMLInputElement = MockHTMLInputElement;
  (globalThis as any).HTMLTextAreaElement = MockHTMLTextAreaElement;
  (globalThis as any).document = mockDocument;

  return { mockDocument, elementsById };
}
