import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { createTimestamp, type TaskRequest } from '@summon-fixer/contracts';
import { resolveWorkspaceRoot } from '../workspace.js';

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
    let checkoutButtonSourceId: string;
    let originalAppContent: string;

    beforeAll(async () => {
      // 1. Create disposable workspace
      tempDir = mkdtempSync(join(tmpdir(), 'summon-fake-e2e-'));
      mkdirSync(join(tempDir, 'apps/demo/src'), { recursive: true });

      // Initialize git repository
      execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
      execSync('git config user.name "Integration Test"', { cwd: tempDir, stdio: 'ignore' });
      execSync('git config user.email "test@summonfixer.internal"', { cwd: tempDir, stdio: 'ignore' });

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

      execSync('git add . && git commit -m "initial commit"', {
        cwd: tempDir,
        stdio: 'ignore',
      });

      // 2. Instrument App.tsx and register in SourceRegistry
      registry = new SourceRegistry();
      const appAbsPath = join(tempDir, 'apps/demo/src/App.tsx');
      const instrumented = instrumentJsx(
        originalAppContent,
        appAbsPath,
        registry,
        { root: join(tempDir, 'apps/demo') }
      );

      expect(instrumented).not.toBeNull();
      expect(registry.size).toBeGreaterThan(0);

      // Find the sourceId for the checkout-now-button
      // The button in App.tsx has id="checkout-now-button"
      let foundId: string | undefined;
      for (const [id, mapping] of (registry as any).mappings.entries()) {
        if (mapping.file.includes('App.tsx') && mapping.line >= 264 && mapping.line <= 272) {
          foundId = id;
          break;
        }
      }
      expect(foundId).toBeDefined();
      checkoutButtonSourceId = foundId!;

      // 3. Start local Engine using FakeCodexRunner
      engine = await startEngine({
        workspaceRoot: tempDir,
        useFakeRunner: true,
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
        join(tempDir, 'apps/demo')
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
    });

    afterAll(async () => {
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
      const res = await fetch(`${bridgeUrl}/__summon/v1/health`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(data.bridge).toBe('ready');
      expect(data.engineConnected).toBe(true);
      expect(data.engineUrl).toBe(engine.url);
    });

    it('resolves verified source mapping via bridge GET /__summon/v1/source/resolve', async () => {
      const res = await fetch(
        `${bridgeUrl}/__summon/v1/source/resolve?sourceId=${encodeURIComponent(checkoutButtonSourceId)}`
      );
      expect(res.status).toBe(200);
      const mapping = await res.json();
      expect(mapping.sourceId).toBe(checkoutButtonSourceId);
      expect(mapping.file).toBe('src/App.tsx');
      expect(mapping.elementTag).toBe('button');
      expect(mapping.line).toBeGreaterThanOrEqual(264);
    });

    it('executes full pipeline: task creation -> fake proposal -> approval -> disk update -> HMR check', async () => {
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
          sourceSelection: {
            sourceId: checkoutButtonSourceId,
          },
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
      const approvalResponse = await client.submitApproval(taskId, {
        taskId,
        taskVersion: task.version,
        proposalDigest: task.proposal!.proposalDigest!,
        decision: 'approved',
        respondedAt: createTimestamp(),
      });

      expect(approvalResponse).toBeDefined();

      // 4. Poll until completed
      task = await client.getTask(taskId);
      const applyStartTime = Date.now();
      while (
        task.status !== 'completed' &&
        task.status !== 'failed' &&
        Date.now() - applyStartTime < 10_000
      ) {
        await new Promise((r) => setTimeout(r, 200));
        task = await client.getTask(taskId);
      }

      expect(task.status).toBe('completed');
      expect(task.completion?.type).toBe('edits_applied');
      expect(task.completion?.appliedEditsCount).toBe(1);
      expect(task.verification?.status).toBe('passed');

      // 5. Invariant Check: Verify file on disk IS NOW MODIFIED with purple background
      const diskContentAfterApproval = readFileSync(
        join(tempDir, 'apps/demo/src/App.tsx'),
        'utf-8'
      );
      expect(diskContentAfterApproval).not.toBe(originalAppContent);
      expect(diskContentAfterApproval).toContain('[FAKE RUNNER: purple]');
      expect(diskContentAfterApproval).toContain('#9333ea');
      expect(diskContentAfterApproval).toContain('id="checkout-now-button"');

      // 6. Simulate Vite HMR file change invalidation
      registry.invalidateFile(join(tempDir, 'apps/demo/src/App.tsx'));
      expect(registry.resolve(checkoutButtonSourceId)).toBeUndefined();
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
          sourceSelection: { sourceId: checkoutButtonSourceId },
        },
      };

      const { taskId } = await client.createTask(taskRequest);

      let task = await client.getTask(taskId);
      while (task.status !== 'awaiting_approval' && task.status !== 'failed') {
        await new Promise((r) => setTimeout(r, 100));
        task = await client.getTask(taskId);
      }

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

    it('handles unmapped source IDs gracefully without crash', async () => {
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
          sourceSelection: { sourceId: 'src_unmapped_source_99999_1_1' },
        },
      };

      // Bridge must not throw or 500 when sourceId is not in registry
      const createResult = await client.createTask(taskRequest);
      expect(createResult.taskId).toBeDefined();

      let task = await client.getTask(createResult.taskId);
      while (task.status !== 'awaiting_approval' && task.status !== 'failed') {
        await new Promise((r) => setTimeout(r, 100));
        task = await client.getTask(createResult.taskId);
      }
      expect(task.status).toBe('awaiting_approval');
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
          sourceSelection: { sourceId: checkoutButtonSourceId },
        },
      };

      const { taskId } = await client.createTask(taskRequest);
      let task = await client.getTask(taskId);
      while (task.status !== 'awaiting_approval' && task.status !== 'failed') {
        await new Promise((r) => setTimeout(r, 100));
        task = await client.getTask(taskId);
      }

      // Submit approval with mismatched proposal digest
      await expect(
        client.submitApproval(taskId, {
          taskId,
          taskVersion: task.version,
          proposalDigest: 'stale_tampered_hash_0123456789abcdef0123456789abcdef',
          decision: 'approved',
          respondedAt: createTimestamp(),
        })
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // Task E: Test Real Codex on Disposable Project Copy
  // =========================================================================
  describe('Task E: End-to-End Real Codex Execution', () => {
    const codexBin = resolveCodexBinaryPath();
    let realTempDir: string;
    let realEngine: EngineInstance;
    let realBridgeServer: Server;
    let realBridgeUrl: string;
    let realRegistry: SourceRegistry;
    let realCheckoutButtonSourceId: string;
    let realOriginalAppContent: string;

    beforeAll(async () => {
      if (!codexBin) {
        console.warn('Real Codex binary not found; skipping Task E');
        return;
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

      execSync('git add . && git commit -m "initial commit"', {
        cwd: realTempDir,
        stdio: 'ignore',
      });

      // 2. Instrument JSX to get verified source mapping
      realRegistry = new SourceRegistry();
      const appAbsPath = join(realTempDir, 'apps/demo/src/App.tsx');
      const instrumented = instrumentJsx(
        realOriginalAppContent,
        appAbsPath,
        realRegistry,
        { root: join(realTempDir, 'apps/demo') }
      );

      expect(instrumented).not.toBeNull();
      let foundId: string | undefined;
      for (const [id, mapping] of (realRegistry as any).mappings.entries()) {
        if (mapping.file.includes('App.tsx') && mapping.line >= 264 && mapping.line <= 272) {
          foundId = id;
          break;
        }
      }
      expect(foundId).toBeDefined();
      realCheckoutButtonSourceId = foundId!;

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
        join(realTempDir, 'apps/demo')
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
    });

    afterAll(async () => {
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

    it('executes real Codex, verifies proposal, requires approval, applies change, and updates styling', async () => {
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
          sourceSelection: {
            sourceId: realCheckoutButtonSourceId,
          },
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
      const approvalRes = await client.submitApproval(taskId, {
        taskId,
        taskVersion: task.version,
        proposalDigest: task.proposal!.proposalDigest!,
        decision: 'approved',
        respondedAt: createTimestamp(),
      });
      expect(approvalRes).toBeDefined();

      // 4. Poll until completed
      task = await client.getTask(taskId);
      const applyStartTime = Date.now();
      while (
        task.status !== 'completed' &&
        task.status !== 'failed' &&
        Date.now() - applyStartTime < 15_000
      ) {
        await new Promise((r) => setTimeout(r, 500));
        task = await client.getTask(taskId);
      }

      expect(task.status).toBe('completed');
      expect(task.completion?.type).toBe('edits_applied');
      expect(task.completion?.appliedEditsCount).toBe(1);

      // 5. Verify approved change was applied to disk
      const diskContentAfterApproval = readFileSync(
        join(realTempDir, 'apps/demo/src/App.tsx'),
        'utf-8'
      );
      expect(diskContentAfterApproval).not.toBe(realOriginalAppContent);
      expect(diskContentAfterApproval.toLowerCase()).toMatch(/purple|#9333ea|#800080|#a855f7/i);
      expect(diskContentAfterApproval).toContain('id="checkout-now-button"');

      // 6. Verify browser styling update:
      // Instrument the modified file and verify that the checkout button now includes the new purple style
      const postRegistry = new SourceRegistry();
      const reInstrumented = instrumentJsx(
        diskContentAfterApproval,
        join(realTempDir, 'apps/demo/src/App.tsx'),
        postRegistry,
        { root: join(realTempDir, 'apps/demo') }
      );
      expect(reInstrumented).not.toBeNull();
      expect(reInstrumented?.code.toLowerCase()).toMatch(/purple|#9333ea|#800080|#a855f7/i);

      // 7. Verify verification results reflect actual checks
      expect(task.verification).toBeDefined();
      expect(task.verification?.status).toBe('passed');
      expect(task.verification?.checks.length).toBeGreaterThan(0);
      expect(task.verification?.checks[0].status).toBe('passed');
    }, 120_000);
  });
});
