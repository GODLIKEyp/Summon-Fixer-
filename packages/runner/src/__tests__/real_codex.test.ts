import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { startEngine, type EngineInstance } from '../engine.js';
import { RealCodexRunner, resolveCodexBinaryPath } from '../codex/real_runner.js';
import { createTimestamp } from '@summon-fixer/contracts';

describe.skipIf(process.env.SUMMON_RUN_REAL_CODEX_TESTS !== '1')('Real Codex End-to-End Execution Flow', () => {
  const codexBin = resolveCodexBinaryPath();
  let tempDir: string;
  let engine: EngineInstance;

  beforeAll(async () => {
    if (!codexBin) {
      throw new Error('Real Codex tests were explicitly enabled but no binary was found');
    }

    tempDir = mkdtempSync(join(tmpdir(), 'summon-codex-e2e-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });

    // Initialize minimal git repo so Codex sees a valid repository
    execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tempDir, stdio: 'ignore' });

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'codex-e2e-test', version: '1.0.0' }, null, 2)
    );
    writeFileSync(
      join(tempDir, 'src/Button.tsx'),
      `export const BUTTON_COLOR = 'blue';\n`
    );

    execSync('git add . && git commit -m "initial commit"', {
      cwd: tempDir,
      stdio: 'ignore',
    });

    const runner = new RealCodexRunner(codexBin);
    engine = await startEngine({
      workspaceRoot: tempDir,
      runner,
      port: 0,
    });
  });

  afterAll(async () => {
    if (engine) {
      await engine.close();
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs real Codex in restricted read-only mode and applies approved change', async () => {
    if (!codexBin) {
      return;
    }

    // 1. Submit task request with source hints
    const createRes = await fetch(`${engine.url}/v1/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${engine.token}`,
      },
      body: JSON.stringify({
        request: {
          requestId: 'req_codex_real_1',
          prompt: "Change BUTTON_COLOR from 'blue' to 'red' in src/Button.tsx",
          requestedMode: 'manual',
          targetFiles: ['src/Button.tsx'],
          createdAt: createTimestamp(),
        },
        sourceHints: [
          {
            filePath: 'src/Button.tsx',
            componentName: 'Button',
            textContent: 'BUTTON_COLOR',
          },
        ],
      }),
    });

    expect(createRes.status).toBe(201);
    const { task } = await createRes.json();
    const taskId = task.taskId;
    expect(taskId).toBeDefined();

    // 2. Poll until Codex finishes read-only planning (timeout 90s for real LLM execution)
    let currentTask = task;
    const startTime = Date.now();
    while (
      currentTask.status !== 'awaiting_approval' &&
      currentTask.status !== 'failed' &&
      Date.now() - startTime < 90_000
    ) {
      await new Promise((r) => setTimeout(r, 1000));
      const getRes = await fetch(`${engine.url}/v1/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${engine.token}` },
      });
      currentTask = (await getRes.json()).task;
    }

    expect(currentTask.status).toBe('awaiting_approval');
    expect(currentTask.proposal).toBeDefined();
    expect(currentTask.proposal.edits.length).toBeGreaterThan(0);

    // 3. Invariant Check: Verify file on disk WAS NOT MODIFIED during proposal stage
    const diskContentBeforeApproval = readFileSync(
      join(tempDir, 'src/Button.tsx'),
      'utf-8'
    );
    expect(diskContentBeforeApproval).toBe(`export const BUTTON_COLOR = 'blue';\n`);

    // 4. Submit approval
    const applyRes = await fetch(`${engine.url}/v1/tasks/${taskId}/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${engine.token}`,
      },
      body: JSON.stringify({
        approval: {
          taskId,
          taskVersion: currentTask.version,
          proposalDigest: currentTask.proposal.proposalDigest,
          decision: 'approved',
          respondedAt: createTimestamp(),
        },
      }),
    });

    expect(applyRes.status).toBe(503);
    const applyData = await applyRes.json();
    expect(applyData.error.code).toBe('SAFE_WRITE_UNAVAILABLE');
    expect(applyData.task.application).toEqual({ status: 'not_applied', appliedEditsCount: 0 });

    // 5. Verify no unsafe automatic write occurred
    const diskContentAfterApproval = readFileSync(
      join(tempDir, 'src/Button.tsx'),
      'utf-8'
    );
    expect(diskContentAfterApproval).toBe(diskContentBeforeApproval);
  }, 120_000); // 120s timeout for real LLM call
});
