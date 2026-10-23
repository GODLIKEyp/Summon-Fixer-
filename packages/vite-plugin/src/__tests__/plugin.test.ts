import { describe, it, expect, beforeEach } from 'vitest';
import { SourceRegistry } from '../source-registry.js';
import { instrumentJsx } from '../jsx-transform.js';
import { isLoopbackUrl, createBridgeMiddleware } from '../bridge.js';
import { summonFixer } from '../index.js';

describe('Summon Fixer Vite Plugin - SourceRegistry', () => {
  let registry: SourceRegistry;

  beforeEach(() => {
    registry = new SourceRegistry();
  });

  it('registers and resolves opaque source IDs', () => {
    const id = registry.register('src/components/ProductCard.tsx', 42, 5, 'button', 'export default function() {}');
    expect(id).toMatch(/^src_[a-f0-9]{8}_42_5$/);

    const mapping = registry.resolve(id);
    expect(mapping).toBeDefined();
    expect(mapping?.file).toBe('src/components/ProductCard.tsx');
    expect(mapping?.line).toBe(42);
    expect(mapping?.column).toBe(5);
    expect(mapping?.elementTag).toBe('button');
    expect(mapping?.revision).toBeDefined();
  });

  it('invalidates file mappings upon HMR file change', () => {
    const id1 = registry.register('src/Header.tsx', 10, 2, 'header');
    const id2 = registry.register('src/Footer.tsx', 20, 2, 'footer');

    expect(registry.size).toBe(2);

    registry.invalidateFile('src/Header.tsx');
    expect(registry.resolve(id1)).toBeUndefined();
    expect(registry.resolve(id2)).toBeDefined();
    expect(registry.size).toBe(1);
  });
});

describe('Summon Fixer Vite Plugin - JSX Transform', () => {
  it('instruments JSX elements with verified data-summon attributes', () => {
    const registry = new SourceRegistry();
    const code = `
      export function CheckoutButton() {
        return (
          <button className="primary-btn" onClick={() => alert('buy')}>
            <span>Checkout</span>
          </button>
        );
      }
    `;

    const result = instrumentJsx(code, '/project/src/CheckoutButton.tsx', registry, { root: '/project' });
    expect(result).not.toBeNull();
    expect(result?.code).toContain('data-summon-id="');
    expect(result?.code).toContain('data-summon-source="src/CheckoutButton.tsx:');
    expect(registry.size).toBeGreaterThan(0);
  });

  it('skips non-JSX and node_modules files', () => {
    const registry = new SourceRegistry();
    const resultJs = instrumentJsx('const a = 1;', '/project/src/utils.ts', registry);
    expect(resultJs).toBeNull();

    const resultVendor = instrumentJsx('<div />', '/project/node_modules/pkg/index.tsx', registry);
    expect(resultVendor).toBeNull();
  });
});

describe('Summon Fixer Vite Plugin - Loopback Security & Bridge', () => {
  it('validates loopback interface addresses strictly', () => {
    expect(isLoopbackUrl('http://127.0.0.1:3883')).toBe(true);
    expect(isLoopbackUrl('http://localhost:5173')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:3883')).toBe(true);

    expect(isLoopbackUrl('http://192.168.1.100:3883')).toBe(false);
    expect(isLoopbackUrl('https://api.summonfixer.com')).toBe(false);
    expect(isLoopbackUrl('http://evil-domain.com')).toBe(false);
  });

  it('rejects non-allowlisted routes with 404', async () => {
    const registry = new SourceRegistry();
    const middleware = createBridgeMiddleware({}, registry);

    let status = 0;
    let body = '';
    const req: any = {
      url: '/__summon/v1/unauthorized/route',
      method: 'GET',
    };
    const res: any = {
      statusCode: 200,
      setHeader: () => {},
      end: (data: string) => {
        status = res.statusCode;
        body = data;
      },
    };
    const next = () => {};

    await middleware(req, res, next);
    expect(status).toBe(404);
    expect(body).toContain('ERR_ROUTE_NOT_ALLOWLISTED');
  });

  it('resolves verified source mapping via bridge /source/resolve', async () => {
    const registry = new SourceRegistry();
    const sourceId = registry.register('src/App.tsx', 15, 3, 'div');
    const middleware = createBridgeMiddleware({}, registry);

    let status = 0;
    let body = '';
    const req: any = {
      url: `/__summon/v1/source/resolve?sourceId=${encodeURIComponent(sourceId)}`,
      method: 'GET',
    };
    const res: any = {
      statusCode: 200,
      setHeader: () => {},
      end: (data: string) => {
        status = res.statusCode;
        body = data;
      },
    };
    const next = () => {};

    await middleware(req, res, next);
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.sourceId).toBe(sourceId);
    expect(parsed.file).toBe('src/App.tsx');
    expect(parsed.line).toBe(15);
  });
});

describe('Summon Fixer Vite Plugin - Production Exclusion', () => {
  it('strictly excludes overlay script from production builds', () => {
    const plugin: any = summonFixer();

    // Dev configuration
    plugin.configResolved?.({ command: 'serve', mode: 'development', root: '/test' });
    const devHtml = plugin.transformIndexHtml?.('<html><body><div id="root"></div></body></html>');
    expect(Array.isArray(devHtml)).toBe(true);
    expect(devHtml[0].tag).toBe('script');
    expect(devHtml[0].attrs.src).toBe('/@summon-overlay/client.js');

    // Production build configuration
    plugin.configResolved?.({ command: 'build', mode: 'production', root: '/test' });
    const prodHtml = plugin.transformIndexHtml?.('<html><body><div id="root"></div></body></html>');
    expect(prodHtml).toBe('<html><body><div id="root"></div></body></html>'); // Untouched string, 0 scripts injected!
  });
});
