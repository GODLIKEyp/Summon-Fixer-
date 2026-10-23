import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEngine, type EngineInstance } from '../engine.js';
import { FakeCodexRunner } from '../codex/fake_runner.js';
import { createTimestamp } from '@summon-fixer/contracts';

describe('Local Engine HTTP Service & Task Lifecycle', () => {
  let tempDir: string;
  let engine: EngineInstance;
  let fakeRunner: FakeCodexRunner;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'summon-engine-test-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'test-pkg' }));
    writeFileSync(
      join(tempDir, 'src/Button.tsx'),
      `export const BUTTON_COLOR = 'blue';\n`
    );

    fakeRunner = new FakeCodexRunner();
    engine = await startEngine({
      workspaceRoot: tempDir,
      runner: fakeRunner,
      port: 0, // dynamic port
    });
  });

  afterEach(async () => {
    await engine.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('responds to health checks with engine status and runner mode', async () => {
    const res = await fetch(`${engine.url}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.engine).toBe('summon-fixer');
    expect(body.runnerMode).toBe('fake');
  });

  it('rejects unauthenticated requests to /v1/tasks', async () => {
    const res = await fetch(`${engine.url}/v1/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Fix button color',
        requestId: 'req_1',
        createdAt: createTimestamp(),
      }),
    });
    expect(res.status).toBe(401);
  });

  it('creates a task and executes planning with FakeCodexRunner', async () => {
    fakeRunner.queueOutput({
      summary: 'Change button color to red',
      edits: [
        {
          path: 'src/Button.tsx',
          changeType: 'update',
          oldContent: `export const BUTTON_COLOR = 'blue';\n`,
          newContent: `export const BUTTON_COLOR = 'red';\n`,
          description: 'Change button color from blue to red',
        },
      ],
    });

    const createRes = await fetch(`${engine.url}/v1/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${engine.token}`,
      },
      body: JSON.stringify({
        request: {
          requestId: 'req_test_1',
          prompt: 'Change button color to red',
          requestedMode: 'manual',
          targetFiles: ['src/Button.tsx'],
          createdAt: createTimestamp(),
        },
      }),
    });

    expect(createRes.status).toBe(201);
    const createData = await createRes.json();
    const taskId = createData.task.taskId;
    expect(taskId).toBeDefined();

    // Poll until task reaches awaiting_approval
    let taskState = createData.task;
    for (let i = 0; i < 20; i++) {
      if (taskState.status === 'awaiting_approval') break;
      await new Promise((r) => setTimeout(r, 50));
      const getRes = await fetch(`${engine.url}/v1/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${engine.token}` },
      });
      taskState = (await getRes.json()).task;
    }

    expect(taskState.status).toBe('awaiting_approval');
    expect(taskState.proposal).toBeDefined();
    expect(taskState.proposal.proposalDigest).toBeDefined();
    expect(taskState.proposal.edits).toHaveLength(1);

    const proposalDigest = taskState.proposal.proposalDigest;
    const taskVersion = taskState.version;

    // Test Stale Version Rejection
    const staleVersionRes = await fetch(`${engine.url}/v1/tasks/${taskId}/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${engine.token}`,
      },
      body: JSON.stringify({
        approval: {
          taskId,
          taskVersion: taskVersion + 1, // Stale version
          proposalDigest,
          decision: 'approved',
          respondedAt: createTimestamp(),
        },
      }),
    });
    expect(staleVersionRes.status).toBe(409);
    const staleData = await staleVersionRes.json();
    expect(staleData.error.code).toBe('STALE_VERSION');

    // Test Stale Digest Rejection
    const staleDigestRes = await fetch(`${engine.url}/v1/tasks/${taskId}/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${engine.token}`,
      },
      body: JSON.stringify({
        approval: {
          taskId,
          taskVersion,
          proposalDigest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', // Wrong digest
          decision: 'approved',
          respondedAt: createTimestamp(),
        },
      }),
    });
    expect(staleDigestRes.status).toBe(409);
    const digestData = await staleDigestRes.json();
    expect(digestData.error.code).toBe('DIGEST_MISMATCH');

    // Test Successful Approval and Apply
    const applyRes = await fetch(`${engine.url}/v1/tasks/${taskId}/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${engine.token}`,
      },
      body: JSON.stringify({
        approval: {
          taskId,
          taskVersion,
          proposalDigest,
          decision: 'approved',
          respondedAt: createTimestamp(),
        },
      }),
    });

    expect(applyRes.status).toBe(200);
    const applyData = await applyRes.json();
    expect(applyData.task.status).toBe('completed');
    expect(applyData.task.completion?.appliedEditsCount).toBe(1);
    expect(applyData.task.verification?.status).toBe('passed');

    // Verify disk mutation
    const diskContent = readFileSync(join(tempDir, 'src/Button.tsx'), 'utf-8');
    expect(diskContent).toBe(`export const BUTTON_COLOR = 'red';\n`);
  });

  it('rejects approval if base content precondition is violated on disk', async () => {
    fakeRunner.queueOutput({
      summary: 'Change button color to red',
      edits: [
        {
          path: 'src/Button.tsx',
          changeType: 'update',
          oldContent: `export const BUTTON_COLOR = 'blue';\n`,
          newContent: `export const BUTTON_COLOR = 'red';\n`,
          description: 'Change button color from blue to red',
        },
      ],
    });

    const createRes = await fetch(`${engine.url}/v1/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${engine.token}`,
      },
      body: JSON.stringify({
        request: {
          requestId: 'req_precond_1',
          prompt: 'Change button color to red',
          requestedMode: 'manual',
          createdAt: createTimestamp(),
        },
      }),
    });

    const createData = await createRes.json();
    const taskId = createData.task.taskId;

    // Wait for awaiting_approval
    let taskState = createData.task;
    for (let i = 0; i < 20; i++) {
      if (taskState.status === 'awaiting_approval') break;
      await new Promise((r) => setTimeout(r, 50));
      const getRes = await fetch(`${engine.url}/v1/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${engine.token}` },
      });
      taskState = (await getRes.json()).task;
    }

    // Externally mutate the file before user approves!
    writeFileSync(
      join(tempDir, 'src/Button.tsx'),
      `export const BUTTON_COLOR = 'purple';\n`
    );

    // Now attempt to approve
    const applyRes = await fetch(`${engine.url}/v1/tasks/${taskId}/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${engine.token}`,
      },
      body: JSON.stringify({
        approval: {
          taskId,
          taskVersion: taskState.version,
          proposalDigest: taskState.proposal.proposalDigest,
          decision: 'approved',
          respondedAt: createTimestamp(),
        },
      }),
    });

    expect(applyRes.status).toBe(412);
    const applyData = await applyRes.json();
    expect(applyData.error.code).toBe('PRECONDITION_FAILED');

    // Verify task failed due to precondition violation
    const getRes = await fetch(`${engine.url}/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${engine.token}` },
    });
    const finalTask = (await getRes.json()).task;
    expect(finalTask.status).toBe('failed');
    expect(finalTask.error?.code).toBe('APPLY_FAILED');
  });

  it('handles user rejection and transitions task to cancelled', async () => {
    fakeRunner.queueOutput({
      summary: 'Change button color to red',
      edits: [
        {
          path: 'src/Button.tsx',
          changeType: 'update',
          oldContent: `export const BUTTON_COLOR = 'blue';\n`,
          newContent: `export const BUTTON_COLOR = 'red';\n`,
          description: 'Change button color from blue to red',
        },
      ],
    });

    const createRes = await fetch(`${engine.url}/v1/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${engine.token}`,
      },
      body: JSON.stringify({
        request: {
          requestId: 'req_reject_1',
          prompt: 'Change button color to red',
          requestedMode: 'manual',
          createdAt: createTimestamp(),
        },
      }),
    });

    const createData = await createRes.json();
    const taskId = createData.task.taskId;

    let taskState = createData.task;
    for (let i = 0; i < 20; i++) {
      if (taskState.status === 'awaiting_approval') break;
      await new Promise((r) => setTimeout(r, 50));
      const getRes = await fetch(`${engine.url}/v1/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${engine.token}` },
      });
      taskState = (await getRes.json()).task;
    }

    const applyRes = await fetch(`${engine.url}/v1/tasks/${taskId}/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${engine.token}`,
      },
      body: JSON.stringify({
        approval: {
          taskId,
          taskVersion: taskState.version,
          proposalDigest: taskState.proposal.proposalDigest,
          decision: 'rejected',
          feedback: 'I want green instead of red',
          respondedAt: createTimestamp(),
        },
      }),
    });

    expect(applyRes.status).toBe(200);
    const finalData = await applyRes.json();
    expect(finalData.task.status).toBe('cancelled');
    expect(finalData.task.error?.message).toBe('I want green instead of red');

    // Verify file on disk remained unmodified
    const diskContent = readFileSync(join(tempDir, 'src/Button.tsx'), 'utf-8');
    expect(diskContent).toBe(`export const BUTTON_COLOR = 'blue';\n`);
  });
});
