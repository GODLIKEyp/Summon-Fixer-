import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createServer, build, type ViteDevServer } from 'vite';
import ts from 'typescript';
import { summonFixer } from '../index.js';
import { SourceRegistry } from '../source-registry.js';
import { instrumentJsx } from '../jsx-transform.js';
import { inspectElement, PromptPanelController, SummonApiClient } from '@summon-fixer/overlay';

const reactPath = dirname(createRequire(import.meta.url).resolve('react/package.json'));
const engineToken = 'fake-engine-secret-for-tests';
const source = 'export const App = () => <button id="checkout">Checkout Now</button>;';
let root: string, vite: ViteDevServer, engine: Server, origin: string, capability: string;
const backendCalls: Array<{ path: string; authorization?: string; body: any }> = [];
let sourceId: string, revision: string;
const nativeFetch = globalThis.fetch;
const jsonHeaders = () => ({ Origin: origin, 'Content-Type': 'application/json', 'X-Summon-Session': capability });
const payload = () => ({ requestId: 'test', prompt: 'Purple please', requestedMode: 'manual', createdAt: new Date().toISOString(),
  context: { sourceSelection: { sourceId, revision } } });
async function reloadMapping() {
  const result = await nativeFetch(origin + '/src/App.tsx');
  const text = await result.text();
  expect(result.status, text.slice(0, 1800)).toBe(200);
  expect(text.slice(0, 1800)).toContain('data-summon-id');
  sourceId = text.match(/["']data-summon-id["']\s*:\s*["']([^"']+)/)![1];
  revision = text.match(/["']data-summon-rev["']\s*:\s*["']([^"']+)/)![1];
}
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'summon-vite-security-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/App.tsx'), source);
  writeFileSync(join(root, 'index.html'), '<div id="root"></div><script type="module" src="/src/App.tsx"></script>');
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  engine = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const body = text ? JSON.parse(text) : null;
    backendCalls.push({ path: req.url!, authorization: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') res.end(JSON.stringify({ status: 'ok', runnerMode: 'fake', engineToken }));
    else { res.statusCode = req.method === 'POST' ? 201 : 200; res.end(JSON.stringify({ task: { taskId: 'fake-task', version: 1, status: 'planning', effectiveMode: 'manual', edits: [] } })); }
  });
  await new Promise<void>((resolve, reject) => { engine.once('error', reject); engine.listen(0, '127.0.0.1', resolve); });
  const port = (engine.address() as any).port;
  vite = await createServer({ configFile: false, root, logLevel: 'silent', resolve: { alias: { react: reactPath } },
    plugins: [summonFixer({ engineUrl: `http://127.0.0.1:${port}`, engineToken, workspaceRoot: root })],
    server: { host: '127.0.0.1', port: 0, cors: { origin: true }, watch: { ignored: ['**/src/App.tsx'] } },
  });
  await vite.listen();
  origin = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
  const bootstrap = await nativeFetch(origin + '/__summon/v1/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Summon-Bootstrap': '1' }, body: '{}' });
  expect(bootstrap.status).toBe(200); capability = (await bootstrap.json()).capability;
  expect(capability).toMatch(/^[a-f0-9]{64}$/); expect(capability).not.toBe(engineToken);
  await reloadMapping();
});
afterAll(async () => { vi.unstubAllGlobals(); await vite?.close(); await new Promise<void>(resolve => engine?.close(() => resolve())); if (root) rmSync(root, { recursive: true, force: true }); });
beforeEach(() => { backendCalls.length = 0; });

describe('Actual Vite middleware order, session bootstrap and authorization', () => {
  it.each([
    ['different port', { Origin: 'http://127.0.0.1:1' }, 403],
    ['different scheme', { Origin: 'https://127.0.0.1:1' }, 403],
    ['different hostname', { Origin: 'http://localhost:1' }, 403],
    ['external origin', { Origin: 'https://example.invalid' }, 403],
    ['null origin', { Origin: 'null' }, 403],
    ['missing origin', { Origin: '' }, 403],
    ['no capability', { 'X-Summon-Session': '' }, 401],
    ['invalid capability', { 'X-Summon-Session': 'b'.repeat(64) }, 401],
    ['text mutation', { 'Content-Type': 'text/plain' }, 415],
    ['form mutation', { 'Content-Type': 'application/x-www-form-urlencoded' }, 415],
    ['cross-site metadata', { 'Sec-Fetch-Site': 'cross-site' }, 403],
  ] as const)('rejects %s with zero engine calls', async (_name, override, status) => {
    const headers = { ...jsonHeaders(), ...override };
    if (_name === 'different scheme') headers.Origin = origin.replace('http:', 'https:');
    if (_name === 'different hostname') headers.Origin = origin.replace('127.0.0.1', 'localhost');
    const res = await nativeFetch(origin + '/__summon/v1/tasks', { method: 'POST', headers, body: JSON.stringify(payload()) });
    expect(res.status).toBe(status); expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(backendCalls).toHaveLength(0);
  });
  it('denies protected reads without a capability and refuses engine bearer as browser capability', async () => {
    for (const headers of [{}, { Authorization: `Bearer ${engineToken}` }, { 'X-Summon-Session': engineToken }]) {
      const res = await nativeFetch(origin + '/__summon/v1/health', { headers: headers as HeadersInit });
      expect(res.status).toBe(401);
    }
    expect(backendCalls).toHaveLength(0);
  });
  it('does not expose bootstrap through permissive Vite CORS, including OPTIONS', async () => {
    expect(vite.config.server.cors).toBe(false);
    for (const method of ['POST', 'OPTIONS']) {
      const res = await nativeFetch(origin + '/__summon/v1/session', { method, headers: { Origin: 'http://localhost:9999', 'Content-Type': 'application/json', 'X-Summon-Bootstrap': '1', 'Access-Control-Request-Method': 'POST' } });
      expect(res.status).toBe(403); expect(res.headers.get('access-control-allow-origin')).toBeNull(); expect(await res.text()).not.toContain(capability);
    }
    const noHeader = await nativeFetch(origin + '/__summon/v1/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
    expect(noHeader.status).toBe(403); expect(backendCalls).toHaveLength(0);
  });
  it('keeps bootstrap and health responses uncached and excludes engine credentials', async () => {
    const res = await nativeFetch(origin + '/__summon/v1/health', { headers: jsonHeaders() });
    expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text(); expect(text).not.toContain(engineToken); expect(text).not.toContain('engineToken');
    expect(backendCalls[0].authorization).toBe(`Bearer ${engineToken}`);
  });
  it('allows authorized GET without Origin, as same-origin browser GET may omit it', async () => {
    const res = await nativeFetch(origin + '/__summon/v1/source/resolve?sourceId=' + sourceId, { headers: { 'X-Summon-Session': capability } });
    expect(res.status).toBe(200); expect((await res.json()).revision).toBe(revision); expect(backendCalls).toHaveLength(0);
  });
  it('rejects a forged external Host before reaching the engine', async () => {
    for (const host of ['evil.invalid', '127.0.0.1:1']) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(origin + '/__summon/v1/health', { headers: { Host: host, 'X-Summon-Session': capability } }, res => { res.resume(); resolve(res.statusCode!); }); req.on('error', reject); req.end();
      });
      expect(status).toBe(403);
    }
    expect(backendCalls).toHaveLength(0);
  });
  it('forwards valid tasks and approvals with only the server-side engine token', async () => {
    for (const [path, body] of [['tasks', payload()], ['tasks/fake-task/approval', { taskId: 'fake-task', taskVersion: 1, proposalDigest: 'a'.repeat(64), decision: 'rejected', respondedAt: new Date().toISOString() }]] as const) {
      const res = await nativeFetch(origin + '/__summon/v1/' + path, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
      expect(res.status).toBe(201);
    }
    expect(backendCalls).toHaveLength(2); expect(backendCalls.every(call => call.authorization === `Bearer ${engineToken}`)).toBe(true);
  });
});

describe('Source integrity before engine forwarding', () => {
  it.each(['missing', 'unknown', 'missingRevision', 'stale'])('rejects %s selection without invoking the engine', async kind => {
    const body: any = payload();
    if (kind === 'missing') delete body.context.sourceSelection;
    if (kind === 'unknown') body.context.sourceSelection.sourceId = 'unknown';
    if (kind === 'missingRevision') delete body.context.sourceSelection.revision;
    if (kind === 'stale') body.context.sourceSelection.revision = 'old';
    const res = await nativeFetch(origin + '/__summon/v1/tasks', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
    expect(res.status).toBe(kind === 'unknown' ? 404 : kind === 'stale' ? 409 : 400);
    expect((await res.json()).error.code).toBe({ missing: 'ERR_SOURCE_REQUIRED', unknown: 'ERR_SOURCE_NOT_FOUND', missingRevision: 'ERR_SOURCE_REVISION_REQUIRED', stale: 'ERR_STALE_SOURCE_REVISION' }[kind]);
    expect(backendCalls).toHaveLength(0);
  });
  it('overwrites browser target paths with the verified file', async () => {
    const body: any = payload(); body.targetFiles = ['other.ts']; body.context.activeFile = { path: 'other.ts' }; body.context.relevantFiles = [{ path: 'other.ts' }];
    const res = await nativeFetch(origin + '/__summon/v1/tasks', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
    expect(res.status).toBe(201); const envelope = backendCalls[0].body;
    expect(envelope.request.targetFiles).toEqual(['src/App.tsx']); expect(envelope.request.context.activeFile.path).toBe('src/App.tsx');
    expect(envelope.request.context.relevantFiles).toEqual([]); expect(envelope.sourceHints[0].filePath).toBe('src/App.tsx');
  });
  it('rejects a changed disk snapshot even before the watcher invalidates the registry', async () => {
    writeFileSync(join(root, 'src/App.tsx'), source + '\n// concurrent change');
    try {
      const res = await nativeFetch(origin + '/__summon/v1/tasks', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(payload()) });
      expect(res.status).toBe(409); expect(backendCalls).toHaveLength(0);
    } finally { writeFileSync(join(root, 'src/App.tsx'), source); }
  });
  it('invalidates a previously served source ID through the real plugin HMR hook', async () => {
    const plugin = vite.config.plugins.find(p => p.name === 'summon-fixer')!;
    await (plugin.handleHotUpdate as any)({ file: join(root, 'src/App.tsx') });
    const res = await nativeFetch(origin + '/__summon/v1/tasks', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(payload()) });
    expect(res.status).toBe(404); expect((await res.json()).error.code).toBe('ERR_SOURCE_NOT_FOUND'); expect(backendCalls).toHaveLength(0);
    vite.moduleGraph.invalidateAll(); await reloadMapping();
  });
  it('carries a real transformed revision through inspector, panel and client into the bridge', async () => {
    // Small DOM fixture: production inspector/panel/client run; no claim of browser layout testing.
    class Element {
      tagName = 'BUTTON'; id = 'checkout'; className = ''; textContent = 'Checkout Now'; nodeType = 1;
      attributes = [{ name: 'data-summon-id', value: sourceId }, { name: 'data-summon-rev', value: revision }, { name: 'data-summon-source', value: 'src/App.tsx:1:26' }];
      parentElement = null;
      getAttribute(name: string) { return this.attributes.find(a => a.name === name)?.value ?? null; }
      closest() { return this; }
    }
    vi.stubGlobal('Node', { ELEMENT_NODE: 1 }); vi.stubGlobal('HTMLInputElement', class {}); vi.stubGlobal('HTMLTextAreaElement', class {});
    vi.stubGlobal('window', { location: { href: origin }, setInterval, clearInterval });
    vi.stubGlobal('fetch', (url: any, init?: RequestInit) => {
      if (String(url).startsWith(origin)) return nativeFetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), Origin: origin } });
      return nativeFetch(url, init);
    });
    const selection = inspectElement(new Element() as any);
    expect(selection.sourceRevision).toBe(revision);
    const container = { innerHTML: '', querySelector() { return null; }, querySelectorAll() { return []; } };
    const panel = new PromptPanelController(container as any, new SummonApiClient({ apiPrefix: origin + '/__summon/v1' }), { onClose() {}, onReselect() {} });
    try {
      panel.open(selection); (panel as any).state.promptText = 'Purple please'; await (panel as any).handleSubmit();
      expect(panel.getState().currentTaskId).toBe('fake-task');
      const call = backendCalls.find(c => c.path === '/v1/tasks')!;
      expect(call.body.request.context.sourceSelection).toEqual({ sourceId, revision });
      expect(call.body.sourceHints[0].filePath).toBe('src/App.tsx');
    } finally { panel.destroy(); vi.unstubAllGlobals(); }
  });
});

describe('Syntax-aware instrumentation and production exclusion', () => {
  it('does not corrupt generic TSX, regexes, strings, comments or template expressions', () => {
    const code = 'const identity = <T extends {}>(x: T) => x; const text = "<div>"; const re = /<button>/; /* <fake/> */ const view = `${(() => <button {...props}>Hi</button>)()}`;';
    const result = instrumentJsx(code, '/project/src/App.tsx', new SourceRegistry(), { root: '/project' })!;
    expect(result.code).toContain('<T extends {}>'); expect(result.code.match(/data-summon-id=/g)).toHaveLength(1);
    expect(result.code).toContain('{...props} data-summon-id='); expect(result.code).toContain('data-summon-rev=');
    const ast = ts.createSourceFile('App.tsx', result.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    expect((ast as any).parseDiagnostics).toEqual([]);
    expect(result.map.sourcesContent).toEqual([code]); expect(result.map.mappings).not.toBe('');
  });
  it('does not let JSX spreads or reserved attributes override the generated revision', () => {
    const code = '<button data-summon-id="spoof" {...props} data-summon-rev="spoof" />';
    const result = instrumentJsx(code, '/project/src/App.tsx', new SourceRegistry(), { root: '/project' })!;
    expect(result.code).not.toContain('spoof'); expect(result.code.match(/data-summon-rev=/g)).toHaveLength(1);
    expect(result.code.indexOf('data-summon-id')).toBeGreaterThan(result.code.indexOf('{...props}'));
  });
  it('builds production with zero overlay, instrumentation, or credentials', async () => {
    const result: any = await build({ configFile: false, root, logLevel: 'silent', resolve: { alias: { react: reactPath } },
      plugins: [summonFixer({ engineToken, workspaceRoot: root })], build: { write: false, minify: false } });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((r: any) => r.output);
    const bundle = outputs.map((o: any) => o.code || String(o.source)).join('\n');
    expect(bundle).not.toMatch(/summon-overlay|data-summon-|X-Summon-Session|__summon\/v1/);
    expect(bundle).not.toContain(engineToken); expect(bundle).not.toContain(capability);
  });
});
