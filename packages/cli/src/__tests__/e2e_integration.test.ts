import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { execSync } from 'node:child_process';
import { startEngine, type EngineInstance } from '@summon-fixer/runner';
import { FakeCodexRunner } from '@summon-fixer/runner';
import { RealCodexRunner, resolveCodexBinaryPath } from '@summon-fixer/runner';
import {
  createBridgeMiddleware,
  SourceRegistry,
  instrumentJsx,
} from '@summon-fixer/vite-plugin';
import { SummonApiClient } from '@summon-fixer/overlay';
import { createTimestamp, type TaskRequest, type SourceSelection } from '@summon-fixer/contracts';
import { resolveWorkspaceRoot } from '../workspace.js';

const nativeFetch = globalThis.fetch;
const apiPrefix = '/__summon/v1';

// Node fetch does not supply the browser's Origin header. Add only that browser
// behavior for this fixture's bridge URL; keep real HTTP, bootstrap and client
// session handling intact, and never decorate direct engine requests.
function emulateBrowserOrigin(origin: string): () => void {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin || !url.pathname.startsWith(apiPrefix + '/')) {
      return nativeFetch(input, init);
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (!headers.has('Origin')) headers.set('Origin', origin);
    return nativeFetch(input, { ...init, headers });
  });
  return () => spy.mockRestore();
}

async function bootstrapSession(origin: string): Promise<string> {
  const res = await nativeFetch(`${origin}${apiPrefix}/session`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Summon-Bootstrap': '1' },
    body: '{}',
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  const { capability } = await res.json();
  if (typeof capability !== 'string' || !/^[a-f0-9]{64}$/.test(capability)) {
    throw new Error('Fixture bootstrap did not return a valid session capability');
  }
  return capability;
}

function authorizedFetch(origin: string, capability: string, path: string, init: RequestInit = {}) {
  const headers = new Headers({ Origin: origin, 'X-Summon-Session': capability, 'Content-Type': 'application/json' });
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return nativeFetch(`${origin}${apiPrefix}${path}`, { ...init, headers });
}

function registerCheckout(content: string, workspace: string, registry: SourceRegistry): SourceSelection {
  registry.clear();
  const transformed = instrumentJsx(content, join(workspace, 'apps/demo/src/App.tsx'), registry,
    { root: join(workspace, 'apps/demo') });
  expect(transformed).not.toBeNull();
  const button = transformed!.code.match(/<button\b[^>]*\bid="checkout-now-button"[^>]*>/)?.[0];
  const sourceId = button?.match(/data-summon-id="([^"]+)"/)?.[1];
  const revision = button?.match(/data-summon-rev="([^"]+)"/)?.[1];
  if (!sourceId || !revision) throw new Error('Checkout instrumentation must include source ID and revision');
  expect(registry.resolve(sourceId)).toMatchObject({ elementTag: 'button', revision });
  return { sourceId, revision };
}

describe('Summon Fixer Phase 3 — End-to-End Vertical Slice Integration', () => {
  // =========================================================================
  // Task D: Test with Fake Runner First
  // =========================================================================
  describe('Task D: Full Pipeline with Fake Runner', () => {
    let tempDir: string;
    let engine: EngineInstance;
    let bridgeServer: Server;
    let bridgeUrl: string;
    let registry: SourceRegistry;
    let checkoutSelection: SourceSelection;
    let session: string;
    let restoreFetch: (() => void) | undefined;
    let fakeRunner: FakeCodexRunner;
    let originalAppContent: string;

    beforeAll(async () => {
      // 1. Create disposable workspace
      tempDir = mkdtempSync(join(tmpdir(), 'summon-fake-e2e-'));
      mkdirSync(join(tempDir, 'apps/demo/src'), { recursive: true });

      // Write root package.json
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify(
          {
            name: 'summon-test-workspace',
            private: true,
            workspaces: ['apps/*'],
          },
          null,
          2
        )
      );

      // Copy real App.tsx content from demo
      const workspaceRoot = resolveWorkspaceRoot(process.cwd());
      originalAppContent = readFileSync(
        join(workspaceRoot, 'apps/demo/src/App.tsx'),
        'utf-8'
      );
      writeFileSync(join(tempDir, 'apps/demo/src/App.tsx'), originalAppContent);

      // Register the exact bytes written to disk, using emitted DOM attributes.
      registry = new SourceRegistry();
      checkoutSelection = registerCheckout(originalAppContent, tempDir, registry);

      // 3. Start local Engine using FakeCodexRunner
      fakeRunner = new FakeCodexRunner();
      engine = await startEngine({
        workspaceRoot: tempDir,
        runner: fakeRunner,
        port: 0,
      });

      // 4. Create Bridge middleware on a dedicated loopback HTTP server
      const bridgeMiddleware = createBridgeMiddleware(
        {
          engineUrl: engine.url,
          engineToken: engine.token,
          workspaceRoot: tempDir,
          apiPrefix: '/__summon/v1',
        },
        registry,
        join(tempDir, 'apps/demo'),
        () => bridgeUrl
      );

      bridgeServer = createServer((req, res) => {
        bridgeMiddleware(req, res, () => {
          res.statusCode = 404;
          res.end('Not Found');
        });
      });

      await new Promise<void>((resolve) => {
        bridgeServer.listen(0, '127.0.0.1', () => resolve());
      });

      const addr = bridgeServer.address() as { port: number };
      bridgeUrl = `http://127.0.0.1:${addr.port}`;
      session = await bootstrapSession(bridgeUrl);
      restoreFetch = emulateBrowserOrigin(bridgeUrl);
    });

    beforeEach(() => {
      // Invalidation in one test must not poison another test's selection.
      expect(readFileSync(join(tempDir, 'apps/demo/src/App.tsx'), 'utf8')).toBe(originalAppContent);
      checkoutSelection = registerCheckout(originalAppContent, tempDir, registry);
    });

    afterAll(async () => {
      restoreFetch?.();
      if (bridgeServer) {
        await new Promise((r) => bridgeServer.close(r));
      }
      if (engine) {
        await engine.close();
      }
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('validates bridge GET /__summon/v1/health returns connected status', async () => {
      const unauthorized = await nativeFetch(`${bridgeUrl}${apiPrefix}/health`, { headers: { Origin: bridgeUrl } });
      expect(unauthorized.status).toBe(401);
      expect((await unauthorized.json()).error.code).toBe('ERR_SESSION_UNAUTHORIZED');
      const res = await authorizedFetch(bridgeUrl, session, '/health');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(data.bridge).toBe('ready');
      expect(data.engineConnected).toBe(true);
      expect(data).not.toHaveProperty('engineUrl');
    });

    it('resolves verified source mapping via bridge GET /__summon/v1/source/resolve', async () => {
      const res = await authorizedFetch(bridgeUrl, session,
        `/source/resolve?sourceId=${encodeURIComponent(checkoutSelection.sourceId)}`);
      expect(res.status).toBe(200);
      const mapping = await res.json();
      expect(mapping.sourceId).toBe(checkoutSelection.sourceId);
      expect(mapping.revision).toBe(checkoutSelection.revision);
      expect(mapping.file).toBe('src/App.tsx');
      expect(mapping.elementTag).toBe('button');
      expect(mapping.line).toBeGreaterThanOrEqual(264);
    });

    it('creates a fake proposal, requires approval and refuses unsupported automatic application', async () => {
      const client = new SummonApiClient({
        apiPrefix: `${bridgeUrl}/__summon/v1`,
      });

      // 1. Submit task request with verified sourceId
      const taskRequest: TaskRequest = {
        requestId: 'req_test_fake_1',
        prompt: "Change this checkout button's background color to purple.",
        requestedMode: 'manual',
        priority: 'normal',
        createdAt: createTimestamp(),
        context: {
          relevantFiles: [],
          sourceSelection: { ...checkoutSelection },
          metadata: {
            elementContext: {
              tagName: 'button',
              textContent: 'Checkout Now • $349.00',
            },
          },
        },
      };

      const createResult = await client.createTask(taskRequest);
      expect(createResult.taskId).toBeDefined();
      const taskId = createResult.taskId;

      // 2. Poll until task enters awaiting_approval
      let task = await client.getTask(taskId);
      const startTime = Date.now();
      while (
        task.status !== 'awaiting_approval' &&
        task.status !== 'failed' &&
        Date.now() - startTime < 10_000
      ) {
        await new Promise((r) => setTimeout(r, 200));
        task = await client.getTask(taskId);
      }

      if (task.status === 'failed') {
        console.error('Task failed during planning:', task.error, task.logs);
      }
      expect(task.status).toBe('awaiting_approval');
      expect(task.proposal).toBeDefined();
      expect(task.proposal?.proposalDigest).toBeDefined();

      // Invariant: Fake runner output must be visibly distinguishable from real Codex output
      expect(task.proposal?.summary).toContain('[FAKE RUNNER]');
      expect(task.proposal?.edits[0].description).toContain('[FAKE RUNNER]');
      expect(task.proposal?.edits[0].newContent).toContain('[FAKE RUNNER: purple]');
      expect(task.proposal?.edits[0].newContent).toContain('#9333ea');
      expect(task.proposal?.edits[0].path).toBe('apps/demo/src/App.tsx');

      // Invariant Check: Verify target file on disk was NOT modified prior to approval
      const diskContentBeforeApproval = readFileSync(
        join(tempDir, 'apps/demo/src/App.tsx'),
        'utf-8'
      );
      expect(diskContentBeforeApproval).toBe(originalAppContent);
      expect(diskContentBeforeApproval).not.toContain('[FAKE RUNNER: purple]');

      // 3. Submit explicit approval tied to proposal digest and task version
      await expect(client.submitApproval(taskId, {
        taskId, taskVersion: task.version, proposalDigest: task.proposal!.proposalDigest!,
        decision: 'approved', respondedAt: createTimestamp(),
      })).rejects.toMatchObject({ status: 503, code: 'SAFE_WRITE_UNAVAILABLE' });
      task = await client.getTask(taskId);
      expect(task.status).toBe('failed');
      expect(task.error?.code).toBe('SAFE_WRITE_UNAVAILABLE');
      expect(task.application).toEqual({ status: 'not_applied', appliedEditsCount: 0 });
      expect(readFileSync(join(tempDir, 'apps/demo/src/App.tsx'), 'utf8')).toBe(originalAppContent);

      // 6. Simulate Vite HMR file change invalidation
      registry.invalidateFile(join(tempDir, 'apps/demo/src/App.tsx'));
      expect(registry.resolve(checkoutSelection.sourceId)).toBeUndefined();
    });

    it('enforces rejection: cancels task without modifying target file', async () => {
      const client = new SummonApiClient({
        apiPrefix: `${bridgeUrl}/__summon/v1`,
      });

      const taskRequest: TaskRequest = {
        requestId: 'req_test_fake_reject',
        prompt: 'Change button to green',
        requestedMode: 'manual',
        priority: 'normal',
        createdAt: createTimestamp(),
        context: {
          relevantFiles: [],
          sourceSelection: { ...checkoutSelection },
        },
      };

      const { taskId } = await client.createTask(taskRequest);

      let task = await client.getTask(taskId);
      const deadline = Date.now() + 10_000;
      while (task.status !== 'awaiting_approval' && task.status !== 'failed' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        task = await client.getTask(taskId);
      }

      expect(task.status).toBe('awaiting_approval');
      const contentBefore = readFileSync(join(tempDir, 'apps/demo/src/App.tsx'), 'utf-8');

      // Reject the proposal
      await client.submitApproval(taskId, {
        taskId,
        taskVersion: task.version,
        proposalDigest: task.proposal!.proposalDigest!,
        decision: 'rejected',
        feedback: 'Do not want this change',
        respondedAt: createTimestamp(),
      });

      task = await client.getTask(taskId);
      expect(task.status).toBe('cancelled');
      expect(task.error?.code).toBe('TASK_CANCELLED');

      // Verify disk was NOT modified
      const contentAfter = readFileSync(join(tempDir, 'apps/demo/src/App.tsx'), 'utf-8');
      expect(contentAfter).toBe(contentBefore);
    });

    it('rejects direct engine requests with invalid credentials', async () => {
      // Direct call to engine port without token
      const resNoToken = await fetch(`${engine.url}/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(resNoToken.status).toBe(401);

      // Direct call with invalid token
      const resBadToken = await fetch(`${engine.url}/v1/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer invalid_secret_token_123',
        },
        body: JSON.stringify({}),
      });
      expect(resBadToken.status).toBe(401);
    });

    it('rejects unknown source IDs with 404 before any engine task starts', async () => {
      const client = new SummonApiClient({
        apiPrefix: `${bridgeUrl}/__summon/v1`,
      });

      const taskRequest: TaskRequest = {
        requestId: 'req_test_unmapped',
        prompt: 'Fix unmapped element',
        requestedMode: 'manual',
        priority: 'normal',
        createdAt: createTimestamp(),
        context: {
          relevantFiles: [],
          sourceSelection: { sourceId: 'src_unmapped_source_99999_1_1', revision: checkoutSelection.revision },
        },
      };

      const taskIdsBefore = engine.server.executor.getAllTasks().map(task => task.taskId);
      const callsBefore = fakeRunner.getCallHistory().length;
      const res = await authorizedFetch(bridgeUrl, session, '/tasks', {
        method: 'POST', body: JSON.stringify(taskRequest),
      });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('ERR_SOURCE_NOT_FOUND');
      await expect(client.createTask(taskRequest)).rejects.toMatchObject({ status: 404, code: 'ERR_SOURCE_NOT_FOUND' });
      expect(engine.server.executor.getAllTasks().map(task => task.taskId)).toEqual(taskIdsBefore);
      expect(fakeRunner.getCallHistory()).toHaveLength(callsBefore);
      expect(readFileSync(join(tempDir, 'apps/demo/src/App.tsx'), 'utf8')).toBe(originalAppContent);
    });

    it('rejects approval with stale or mismatched proposal digest', async () => {
      const client = new SummonApiClient({
        apiPrefix: `${bridgeUrl}/__summon/v1`,
      });

      const taskRequest: TaskRequest = {
        requestId: 'req_test_stale_digest',
        prompt: 'Change font size',
        requestedMode: 'manual',
        priority: 'normal',
        createdAt: createTimestamp(),
        context: {
          relevantFiles: [],
          sourceSelection: { ...checkoutSelection },
        },
      };

      const { taskId } = await client.createTask(taskRequest);
      let task = await client.getTask(taskId);
      const deadline = Date.now() + 10_000;
      while (task.status !== 'awaiting_approval' && task.status !== 'failed' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        task = await client.getTask(taskId);
      }

      expect(task.status).toBe('awaiting_approval');
      // Submit approval with mismatched proposal digest
      await expect(
        client.submitApproval(taskId, {
          taskId,
          taskVersion: task.version,
          proposalDigest: 'stale_tampered_hash_0123456789abcdef0123456789abcdef',
          decision: 'approved',
          respondedAt: createTimestamp(),
        })
      ).rejects.toMatchObject({ status: 409, code: 'DIGEST_MISMATCH' });
      expect((await client.getTask(taskId)).status).toBe('awaiting_approval');
      expect(readFileSync(join(tempDir, 'apps/demo/src/App.tsx'), 'utf8')).toBe(originalAppContent);
    });
  });

  // =========================================================================
  // Task E: Test Real Codex on Disposable Project Copy
  // =========================================================================
  describe.skipIf(process.env.SUMMON_RUN_REAL_CODEX_TESTS !== '1')('Task E: End-to-End Real Codex Execution', () => {
    const codexBin = resolveCodexBinaryPath();
    let realTempDir: string;
    let realEngine: EngineInstance;
    let realBridgeServer: Server;
    let realBridgeUrl: string;
    let realRegistry: SourceRegistry;
    let realCheckoutSelection: SourceSelection;
    let restoreRealFetch: (() => void) | undefined;
    let realOriginalAppContent: string;

    beforeAll(async () => {
      if (!codexBin) {
        throw new Error('Real Codex tests were explicitly enabled but no binary was found');
      }

      // 1. Create fresh disposable project copy
      realTempDir = mkdtempSync(join(tmpdir(), 'summon-real-e2e-'));
      mkdirSync(join(realTempDir, 'apps/demo/src'), { recursive: true });

      execSync('git init -b main', { cwd: realTempDir, stdio: 'ignore' });
      execSync('git config user.name "Codex Integration"', { cwd: realTempDir, stdio: 'ignore' });
      execSync('git config user.email "codex@summonfixer.internal"', { cwd: realTempDir, stdio: 'ignore' });

      writeFileSync(
        join(realTempDir, 'package.json'),
        JSON.stringify(
          {
            name: 'summon-real-workspace',
            private: true,
            workspaces: ['apps/*'],
          },
          null,
          2
        )
      );

      const workspaceRoot = resolveWorkspaceRoot(process.cwd());
      realOriginalAppContent = readFileSync(
        join(workspaceRoot, 'apps/demo/src/App.tsx'),
        'utf-8'
      );
      writeFileSync(join(realTempDir, 'apps/demo/src/App.tsx'), realOriginalAppContent);

      realRegistry = new SourceRegistry();
      realCheckoutSelection = registerCheckout(realOriginalAppContent, realTempDir, realRegistry);

      // 3. Start engine with RealCodexRunner
      const runner = new RealCodexRunner(codexBin);
      realEngine = await startEngine({
        workspaceRoot: realTempDir,
        runner,
        port: 0,
      });

      // 4. Start bridge server
      const bridgeMiddleware = createBridgeMiddleware(
        {
          engineUrl: realEngine.url,
          engineToken: realEngine.token,
          workspaceRoot: realTempDir,
          apiPrefix: '/__summon/v1',
        },
        realRegistry,
        join(realTempDir, 'apps/demo'),
        () => realBridgeUrl
      );

      realBridgeServer = createServer((req, res) => {
        bridgeMiddleware(req, res, () => {
          res.statusCode = 404;
          res.end('Not Found');
        });
      });

      await new Promise<void>((resolve) => {
        realBridgeServer.listen(0, '127.0.0.1', () => resolve());
      });

      const addr = realBridgeServer.address() as { port: number };
      realBridgeUrl = `http://127.0.0.1:${addr.port}`;
      await bootstrapSession(realBridgeUrl);
      restoreRealFetch = emulateBrowserOrigin(realBridgeUrl);
    });

    afterAll(async () => {
      restoreRealFetch?.();
      if (realBridgeServer) {
        await new Promise((r) => realBridgeServer.close(r));
      }
      if (realEngine) {
        await realEngine.close();
      }
      if (realTempDir) {
        rmSync(realTempDir, { recursive: true, force: true });
      }
    });

    it('executes opt-in real Codex planning and fails closed on unsupported application', async () => {
      if (!codexBin) {
        return;
      }

      const client = new SummonApiClient({
        apiPrefix: `${realBridgeUrl}/__summon/v1`,
      });

      // 1. Send task request: "Change this checkout button's background color to purple."
      const taskRequest: TaskRequest = {
        requestId: 'req_real_codex_purple_1',
        prompt: "Change this checkout button's background color to purple.",
        requestedMode: 'manual',
        priority: 'normal',
        createdAt: createTimestamp(),
        context: {
          relevantFiles: [],
          sourceSelection: { ...realCheckoutSelection },
          metadata: {
            elementContext: {
              tagName: 'button',
              textContent: 'Checkout Now • $349.00',
            },
          },
        },
      };

      const createRes = await client.createTask(taskRequest);
      expect(createRes.taskId).toBeDefined();
      const taskId = createRes.taskId;

      // 2. Poll until real Codex completes read-only planning (timeout 90s for real LLM call)
      let task = await client.getTask(taskId);
      const startTime = Date.now();
      while (
        task.status !== 'awaiting_approval' &&
        task.status !== 'failed' &&
        Date.now() - startTime < 90_000
      ) {
        await new Promise((r) => setTimeout(r, 1000));
        task = await client.getTask(taskId);
      }

      expect(task.status).toBe('awaiting_approval');
      expect(task.proposal).toBeDefined();

      // Verify a real Codex process was executed
      const edits = task.proposal?.edits ?? [];
      expect(edits.length).toBeGreaterThan(0);

      // Verify correct source file was identified
      expect(edits[0].path).toBe('apps/demo/src/App.tsx');

      // Verify proposed edit modifies styling to purple
      const newContent = edits[0].newContent ?? '';
      expect(newContent.toLowerCase()).toMatch(/purple|#9333ea|#800080|#a855f7|background/i);

      // Verify NO file changed before approval
      const diskContentBeforeApproval = readFileSync(
        join(realTempDir, 'apps/demo/src/App.tsx'),
        'utf-8'
      );
      expect(diskContentBeforeApproval).toBe(realOriginalAppContent);

      // 3. Submit explicit user approval
      await expect(client.submitApproval(taskId, {
        taskId, taskVersion: task.version, proposalDigest: task.proposal!.proposalDigest!,
        decision: 'approved', respondedAt: createTimestamp(),
      })).rejects.toMatchObject({ status: 503, code: 'SAFE_WRITE_UNAVAILABLE' });
      task = await client.getTask(taskId);
      expect(task.error?.code).toBe('SAFE_WRITE_UNAVAILABLE');
      expect(task.application).toEqual({ status: 'not_applied', appliedEditsCount: 0 });
      expect(readFileSync(join(realTempDir, 'apps/demo/src/App.tsx'), 'utf8')).toBe(realOriginalAppContent);
    }, 120_000);
  });
});
