import { describe, it, expect, beforeEach } from 'vitest';
import { SourceRegistry } from '../source-registry.js';
import { createBridgeMiddleware, isLoopbackUrl } from '../bridge.js';

describe('Phase 5B Security - Bridge Health Endpoint Token Leak', () => {
  it('health response excludes engineUrl from JSON output', async () => {
    const registry = new SourceRegistry();
    const middleware = createBridgeMiddleware(
      { engineUrl: 'http://127.0.0.1:3883', engineToken: 'super-secret' },
      registry
    );

    let body = '';
    const req: any = { url: '/__summon/v1/health', method: 'GET', headers: {} };
    const res: any = {
      statusCode: 200,
      setHeader: () => {},
      end: (data: string) => { body = data; },
    };

    await middleware(req, res, () => {});
    const parsed = JSON.parse(body);
    expect(parsed).not.toHaveProperty('engineUrl');
    expect(body).not.toContain('super-secret');
  });

  it('health response still reports engineConnected status', async () => {
    const registry = new SourceRegistry();
    const middleware = createBridgeMiddleware({}, registry);

    let body = '';
    const req: any = { url: '/__summon/v1/health', method: 'GET', headers: {} };
    const res: any = {
      statusCode: 200,
      setHeader: () => {},
      end: (data: string) => { body = data; },
    };

    await middleware(req, res, () => {});
    const parsed = JSON.parse(body);
    expect(parsed).toHaveProperty('engineConnected');
    expect(parsed.bridge).toBe('ready');
  });
});

describe('Phase 5B Security - Source Revision Mismatch Rejection', () => {
  it('returns 409 when client revision does not match registry revision', async () => {
    const registry = new SourceRegistry();
    const sourceId = registry.register(
      'src/App.tsx',
      10,
      3,
      'div',
      'const App = () => <div>Hello</div>;'
    );

    const middleware = createBridgeMiddleware({}, registry);

    const payload = {
      requestId: 'req_stale_test',
      prompt: 'Fix the button color',
      requestedMode: 'manual',
      priority: 'normal',
      createdAt: new Date().toISOString(),
      context: {
        sourceSelection: {
          sourceId,
          revision: 'wrong_old_revision',
        },
      },
    };

    const bodyBuf = Buffer.from(JSON.stringify(payload));
    let status = 0;
    let body = '';

    const req: any = {
      url: '/__summon/v1/tasks',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      [Symbol.asyncIterator]: async function* () { yield bodyBuf; },
    };
    const res: any = {
      statusCode: 200,
      setHeader: () => {},
      end: (data: string) => { status = res.statusCode; body = data; },
    };

    await middleware(req, res, () => {});
    expect(status).toBe(409);
    expect(JSON.parse(body).error.code).toBe('ERR_STALE_SOURCE_REVISION');
  });

  it('allows task when client revision matches registry revision', async () => {
    const registry = new SourceRegistry();
    const sourceId = registry.register(
      'src/App.tsx',
      10,
      3,
      'div',
      'const App = () => <div>Hello</div>;'
    );
    const mapping = registry.resolve(sourceId)!;

    const middleware = createBridgeMiddleware({}, registry);

    const payload = {
      requestId: 'req_fresh_test',
      prompt: 'Fix the button',
      requestedMode: 'manual',
      priority: 'normal',
      createdAt: new Date().toISOString(),
      context: {
        sourceSelection: {
          sourceId,
          revision: mapping.revision,
        },
      },
    };

    const bodyBuf = Buffer.from(JSON.stringify(payload));
    let status = 0;

    const req: any = {
      url: '/__summon/v1/tasks',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      [Symbol.asyncIterator]: async function* () { yield bodyBuf; },
    };
    const res: any = {
      statusCode: 200,
      setHeader: () => {},
      end: () => { status = res.statusCode; },
    };

    await middleware(req, res, () => {});
    // Should not be 409 — it will be 503 (engine not running) which is expected
    expect(status).not.toBe(409);
  });
});

describe('Phase 5B Security - Source Registry Stale Invalidation', () => {
  it('invalidates mappings when file path is an absolute path suffix match', () => {
    const registry = new SourceRegistry();
    registry.register('src/Card.tsx', 5, 1, 'div', 'export const Card = () => <div />;');
    expect(registry.size).toBe(1);

    registry.invalidateFile('/Users/dev/project/src/Card.tsx');
    expect(registry.size).toBe(0);
  });

  it('invalidates fileRevisions alongside mappings on absolute path', () => {
    const registry = new SourceRegistry();
    const id = registry.register('src/Card.tsx', 5, 1, 'div', 'content v1');
    const revBefore = registry.resolve(id)?.revision;
    expect(revBefore).toBeDefined();

    registry.invalidateFile('/abs/path/src/Card.tsx');
    expect(registry.resolve(id)).toBeUndefined();

    const id2 = registry.register('src/Card.tsx', 5, 1, 'div', 'content v2');
    const revAfter = registry.resolve(id2)?.revision;
    expect(revAfter).toBeDefined();
    expect(revAfter).not.toBe(revBefore);
  });

  it('does not cross-invalidate unrelated files', () => {
    const registry = new SourceRegistry();
    registry.register('src/A.tsx', 1, 1, 'div', 'a');
    registry.register('src/B.tsx', 1, 1, 'div', 'b');
    expect(registry.size).toBe(2);

    registry.invalidateFile('src/A.tsx');
    expect(registry.size).toBe(1);
  });
});

describe('Phase 5B Security - Cross-Origin Rejection', () => {
  it('rejects requests from non-loopback origins', async () => {
    const registry = new SourceRegistry();
    const middleware = createBridgeMiddleware({}, registry);

    let status = 0;
    let body = '';
    const req: any = {
      url: '/__summon/v1/health',
      method: 'GET',
      headers: {
        origin: 'https://evil-site.com',
        host: 'localhost:5173',
      },
    };
    const res: any = {
      statusCode: 200,
      setHeader: () => {},
      end: (data: string) => { status = res.statusCode; body = data; },
    };

    await middleware(req, res, () => {});
    expect(status).toBe(403);
    expect(JSON.parse(body).error.code).toBe('ERR_FORBIDDEN_ORIGIN');
  });

  it('allows requests from localhost origin', async () => {
    const registry = new SourceRegistry();
    const middleware = createBridgeMiddleware({}, registry);

    let status = 0;
    const req: any = {
      url: '/__summon/v1/health',
      method: 'GET',
      headers: {
        origin: 'http://localhost:5173',
        host: 'localhost:5173',
      },
    };
    const res: any = {
      statusCode: 200,
      setHeader: () => {},
      end: () => { status = res.statusCode; },
    };

    await middleware(req, res, () => {});
    expect(status).toBe(200);
  });
});
