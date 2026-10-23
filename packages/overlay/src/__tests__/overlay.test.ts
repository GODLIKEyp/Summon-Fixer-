import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDom } from './test-dom.js';
import { inspectElement, extractVerifiedSource, getElementSelector } from '../inspector.js';
import { SummonApiClient } from '../client-api.js';

describe('Summon Fixer Overlay - Inspector', () => {
  beforeEach(() => {
    setupTestDom();
  });

  it('correctly inspects a basic DOM element', () => {
    const btn = document.createElement('button');
    btn.className = 'btn-primary custom-action';
    btn.textContent = '  Checkout Now  ';
    btn.setAttribute('aria-label', 'Proceed to Checkout');
    btn.setAttribute('data-testid', 'checkout-button');
    document.body.appendChild(btn);

    const context = inspectElement(btn);

    expect(context.tagName).toBe('BUTTON');
    expect(context.textContent).toBe('Checkout Now');
    expect(context.accessibleLabel).toBe('Proceed to Checkout');
    expect(context.attributes['data-testid']).toBe('checkout-button');
    expect(context.elementSelector).toContain('button.btn-primary');
    expect(context.sourceId).toBeUndefined();
    expect(context.sourceLocation).toBeUndefined();
  });

  it('captures verified source from data-summon-id and data-summon-source', () => {
    const card = document.createElement('div');
    card.setAttribute('data-summon-id', 'src_prod_card_1');
    card.setAttribute('data-summon-source', 'src/components/ProductCard.tsx:42:5');
    card.setAttribute('data-summon-rev', 'rev_abc123');

    const innerBtn = document.createElement('button');
    innerBtn.textContent = 'Add to Cart';
    card.appendChild(innerBtn);
    document.body.appendChild(card);

    const context = inspectElement(innerBtn);

    expect(context.sourceId).toBe('src_prod_card_1');
    expect(context.sourceRevision).toBe('rev_abc123');
    expect(context.sourceLocation).toEqual({
      file: 'src/components/ProductCard.tsx',
      line: 42,
      column: 5,
    });
  });

  it('never invents fake source location when unmapped', () => {
    const div = document.createElement('div');
    div.textContent = 'Plain unmapped element';
    document.body.appendChild(div);

    const source = extractVerifiedSource(div);
    expect(source.sourceId).toBeUndefined();
    expect(source.sourceLocation).toBeUndefined();
  });

  it('builds concise CSS selector hierarchy', () => {
    const container = document.createElement('div');
    container.className = 'shop-container';

    const card = document.createElement('article');
    card.className = 'product-card';

    const btn = document.createElement('button');
    btn.id = 'buy-now-btn';

    card.appendChild(btn);
    container.appendChild(card);
    document.body.appendChild(container);

    const selector = getElementSelector(btn);
    expect(selector).toBe('#buy-now-btn');
  });
});

describe('Summon Fixer Overlay - API Client', () => {
  it('instantiates with custom or default prefix', () => {
    const client = new SummonApiClient();
    expect(client).toBeDefined();

    const customClient = new SummonApiClient({ apiPrefix: '/custom/__summon/v1' });
    expect(customClient).toBeDefined();
  });

  it('reports connection failure cleanly without throwing unhandled rejection on health check', async () => {
    const client = new SummonApiClient({ apiPrefix: 'http://127.0.0.1:9999/__summon/v1' });
    const health = await client.checkHealth();
    expect(health.engineConnected).toBe(false);
  });
});
