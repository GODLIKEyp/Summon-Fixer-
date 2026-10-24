import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTimestamp } from '@summon-fixer/contracts';
import { startEngine, type EngineInstance } from '../engine.js';
import { FakeCodexRunner } from '../codex/fake_runner.js';
import {
  validateWorkspaceContainment,
  validateEditPolicy,
  SecurityError,
} from '../security.js';
import {
  RealCodexRunner,
  CodexExecutionError,
  MAX_CODEX_OUTPUT_BYTES,
} from '../codex/real_runner.js';
import { TaskExecutor, TaskExecutionError } from '../executor.js';

describe('Summon Fixer Phase 5A — Engine Security Remediation Regression Suite', () => {
  let tempDir: string;
  let engine: EngineInstance;
  let fakeRunner: FakeCodexRunner;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'summon-remediation-test-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'test-remediation' }));
    writeFileSync(
      join(tempDir, 'src/Button.tsx'),
      `export const BUTTON_COLOR = 'blue';\nexport const BUTTON_SIZE = 'medium';\n`
    );

    fakeRunner = new FakeCodexRunner();
    engine = await startEngine({
      workspaceRoot: tempDir,
      runner: fakeRunner,
      port: 0,
    });
  });

  afterEach(async () => {
    await engine.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Task 1: Workspace Containment & Symlink Attacks
  // =========================================================================
  describe('Task 1: Workspace Containment & Symlinks (lstat validation)', () => {
    it('rejects dangling symlink targets pointing to non-existent files', () => {
      const danglingLink = join(tempDir, 'dangling.ts');
      symlinkSync(join(tempDir, 'non-existent-target.ts'), danglingLink);

      expect(() => {
        validateWorkspaceContainment(tempDir, 'dangling.ts');
      }).toThrowError(/Symlink escape detected: symlink targets and path components are forbidden/);
    });

    it('rejects symlink path components where an intermediate directory is a symlink', () => {
      const realDir = mkdtempSync(join(tmpdir(), 'summon-real-dir-'));
      const symlinkDir = join(tempDir, 'symlink-dir');
      symlinkSync(realDir, symlinkDir);

      writeFileSync(join(realDir, 'file.ts'), 'content');

      expect(() => {
        validateWorkspaceContainment(tempDir, 'symlink-dir/file.ts');
      }).toThrowError(/Symlink escape detected: symlink targets and path components are forbidden/);

      rmSync(realDir, { recursive: true, force: true });
    });

    it('rejects at application time if target file is swapped for a symlink after proposal', async () => {
      fakeRunner.queueOutput({
        summary: 'Change button color',
        edits: [
          {
            path: 'src/Button.tsx',
            changeType: 'update',
            oldContent: `export const BUTTON_COLOR = 'blue';\n`,
            newContent: `export const BUTTON_COLOR = 'red';\n`,
            description: 'Change button color',
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
            requestId: 'req_symlink_swap',
            prompt: 'Change button color',
            requestedMode: 'manual',
            targetFiles: ['src/Button.tsx'],
            createdAt: createTimestamp(),
          },
        }),
      });

      const { task } = await createRes.json();
      let taskState = task;
      for (let i = 0; i < 20; i++) {
        if (taskState.status === 'awaiting_approval') break;
        await new Promise((r) => setTimeout(r, 50));
        const getRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}`, {
          headers: { Authorization: `Bearer ${engine.token}` },
        });
        taskState = (await getRes.json()).task;
      }

      expect(taskState.status).toBe('awaiting_approval');

      // Swap the file for a symlink pointing outside the workspace!
      const outsideDir = mkdtempSync(join(tmpdir(), 'summon-sec-outside-'));
      const outsideFile = join(outsideDir, 'secret.txt');
      writeFileSync(outsideFile, 'secret data');

      rmSync(join(tempDir, 'src/Button.tsx'));
      symlinkSync(outsideFile, join(tempDir, 'src/Button.tsx'));

      // Attempt to apply approval
      const applyRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}/apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${engine.token}`,
        },
        body: JSON.stringify({
          approval: {
            taskId: task.taskId,
            taskVersion: taskState.version,
            proposalDigest: taskState.proposal.proposalDigest,
            decision: 'approved',
            respondedAt: createTimestamp(),
          },
        }),
      });

      // Must be rejected at application time
      expect(applyRes.status).toBeGreaterThanOrEqual(400);

      // Verify outside file was NOT modified
      expect(readFileSync(outsideFile, 'utf-8')).toBe('secret data');
      rmSync(outsideDir, { recursive: true, force: true });
    });
  });

  // =========================================================================
  // Task 2: Single-File Update Restriction
  // =========================================================================
  describe('Task 2: Single-File Update Restriction', () => {
    it('explicitly rejects multi-file proposals', async () => {
      fakeRunner.queueOutput({
        summary: 'Multi-file change attempt',
        edits: [
          {
            path: 'src/Button.tsx',
            changeType: 'update',
            oldContent: `export const BUTTON_COLOR = 'blue';\n`,
            newContent: `export const BUTTON_COLOR = 'red';\n`,
            description: 'Change button',
          },
          {
            path: 'package.json',
            changeType: 'update',
            oldContent: JSON.stringify({ name: 'test-remediation' }),
            newContent: JSON.stringify({ name: 'test-remediation-modified' }),
            description: 'Change package.json',
          },
        ],
      });

      const res = await fetch(`${engine.url}/v1/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${engine.token}`,
        },
        body: JSON.stringify({
          request: {
            requestId: 'req_multifile',
            prompt: 'Update multiple files',
            requestedMode: 'manual',
            createdAt: createTimestamp(),
          },
        }),
      });

      const { task } = await res.json();
      let taskState = task;
      for (let i = 0; i < 20; i++) {
        if (taskState.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 50));
        const getRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}`, {
          headers: { Authorization: `Bearer ${engine.token}` },
        });
        taskState = (await getRes.json()).task;
      }

      expect(taskState.status).toBe('failed');
      expect(taskState.error?.message).toContain('Multi-file modifications are not supported in this release');
    });

    it('explicitly rejects file creation proposals', async () => {
      fakeRunner.queueOutput({
        summary: 'File creation attempt',
        edits: [
          {
            path: 'src/NewComponent.tsx',
            changeType: 'create',
            newContent: 'export const NewComponent = () => null;',
            description: 'Create new component',
          },
        ],
      });

      const res = await fetch(`${engine.url}/v1/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${engine.token}`,
        },
        body: JSON.stringify({
          request: {
            requestId: 'req_create_file',
            prompt: 'Create new file',
            requestedMode: 'manual',
            createdAt: createTimestamp(),
          },
        }),
      });

      const { task } = await res.json();
      let taskState = task;
      for (let i = 0; i < 20; i++) {
        if (taskState.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 50));
        const getRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}`, {
          headers: { Authorization: `Bearer ${engine.token}` },
        });
        taskState = (await getRes.json()).task;
      }

      expect(taskState.status).toBe('failed');
      expect(taskState.error?.message).toContain('File creation is not supported in this release');
    });

    it('explicitly rejects file deletion proposals', async () => {
      fakeRunner.queueOutput({
        summary: 'File deletion attempt',
        edits: [
          {
            path: 'src/Button.tsx',
            changeType: 'delete',
            description: 'Delete button',
          },
        ],
      });

      const res = await fetch(`${engine.url}/v1/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${engine.token}`,
        },
        body: JSON.stringify({
          request: {
            requestId: 'req_delete_file',
            prompt: 'Delete file',
            requestedMode: 'manual',
            createdAt: createTimestamp(),
          },
        }),
      });

      const { task } = await res.json();
      let taskState = task;
      for (let i = 0; i < 20; i++) {
        if (taskState.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 50));
        const getRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}`, {
          headers: { Authorization: `Bearer ${engine.token}` },
        });
        taskState = (await getRes.json()).task;
      }

      expect(taskState.status).toBe('failed');
      expect(taskState.error?.message).toContain('File deletion is not supported in this release');
    });

    it('rejects update proposals targeting a non-existent file', async () => {
      fakeRunner.queueOutput({
        summary: 'Non-existent file update',
        edits: [
          {
            path: 'src/DoesNotExist.tsx',
            changeType: 'update',
            oldContent: 'old',
            newContent: 'new',
            description: 'Update non-existent file',
          },
        ],
      });

      const res = await fetch(`${engine.url}/v1/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${engine.token}`,
        },
        body: JSON.stringify({
          request: {
            requestId: 'req_missing_file',
            prompt: 'Update missing file',
            requestedMode: 'manual',
            createdAt: createTimestamp(),
          },
        }),
      });

      const { task } = await res.json();
      let taskState = task;
      for (let i = 0; i < 20; i++) {
        if (taskState.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 50));
        const getRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}`, {
          headers: { Authorization: `Bearer ${engine.token}` },
        });
        taskState = (await getRes.json()).task;
      }

      expect(taskState.status).toBe('failed');
      expect(taskState.error?.code).toBe('PROPOSAL_GENERATION_FAILED');
      expect(taskState.error?.message).toContain('does not exist on disk');
    });
  });

  // =========================================================================
  // Task 3: Approval Scope Enforcement
  // =========================================================================
  describe('Task 3: Approval Scope Enforcement', () => {
    it('rejects apply request if approval body taskId does not match URL taskId', async () => {
      fakeRunner.queueOutput({
        summary: 'Change button color',
        edits: [
          {
            path: 'src/Button.tsx',
            changeType: 'update',
            oldContent: `export const BUTTON_COLOR = 'blue';\n`,
            newContent: `export const BUTTON_COLOR = 'red';\n`,
            description: 'Change button',
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
            requestId: 'req_task_id_mismatch',
            prompt: 'Change button color',
            requestedMode: 'manual',
            createdAt: createTimestamp(),
          },
        }),
      });

      const { task } = await createRes.json();
      let taskState = task;
      for (let i = 0; i < 20; i++) {
        if (taskState.status === 'awaiting_approval') break;
        await new Promise((r) => setTimeout(r, 50));
        const getRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}`, {
          headers: { Authorization: `Bearer ${engine.token}` },
        });
        taskState = (await getRes.json()).task;
      }

      // Send approval with mismatched taskId in body
      const applyRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}/apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${engine.token}`,
        },
        body: JSON.stringify({
          approval: {
            taskId: 'different_task_id_999',
            taskVersion: taskState.version,
            proposalDigest: taskState.proposal.proposalDigest,
            decision: 'approved',
            respondedAt: createTimestamp(),
          },
        }),
      });

      expect(applyRes.status).toBe(400);
      const applyData = await applyRes.json();
      expect(applyData.error.code).toBe('TASK_ID_MISMATCH');
    });

    it('rejects approval with explicit approvedPaths: [] and does NOT approve all edits', async () => {
      fakeRunner.queueOutput({
        summary: 'Change button color',
        edits: [
          {
            path: 'src/Button.tsx',
            changeType: 'update',
            oldContent: `export const BUTTON_COLOR = 'blue';\n`,
            newContent: `export const BUTTON_COLOR = 'red';\n`,
            description: 'Change button',
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
            requestId: 'req_empty_approved_paths',
            prompt: 'Change button color',
            requestedMode: 'manual',
            createdAt: createTimestamp(),
          },
        }),
      });

      const { task } = await createRes.json();
      let taskState = task;
      for (let i = 0; i < 20; i++) {
        if (taskState.status === 'awaiting_approval') break;
        await new Promise((r) => setTimeout(r, 50));
        const getRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}`, {
          headers: { Authorization: `Bearer ${engine.token}` },
        });
        taskState = (await getRes.json()).task;
      }

      // Send approval with approvedPaths: []
      const applyRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}/apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${engine.token}`,
        },
        body: JSON.stringify({
          approval: {
            taskId: task.taskId,
            taskVersion: taskState.version,
            proposalDigest: taskState.proposal.proposalDigest,
            decision: 'approved',
            approvedPaths: [], // Explicitly empty
            respondedAt: createTimestamp(),
          },
        }),
      });

      expect(applyRes.status).toBe(400);
      const applyData = await applyRes.json();
      expect(applyData.error.code).toBe('EMPTY_APPROVED_PATHS');
      expect(applyData.error.message).toContain('Explicit approvedPaths is empty');

      // Verify file was NOT modified
      expect(readFileSync(join(tempDir, 'src/Button.tsx'), 'utf-8')).toContain(`BUTTON_COLOR = 'blue'`);
    });

    it('rejects approval containing an unknown approved path', async () => {
      fakeRunner.queueOutput({
        summary: 'Change button color',
        edits: [
          {
            path: 'src/Button.tsx',
            changeType: 'update',
            oldContent: `export const BUTTON_COLOR = 'blue';\n`,
            newContent: `export const BUTTON_COLOR = 'red';\n`,
            description: 'Change button',
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
            requestId: 'req_unknown_approved_path',
            prompt: 'Change button color',
            requestedMode: 'manual',
            createdAt: createTimestamp(),
          },
        }),
      });

      const { task } = await createRes.json();
      let taskState = task;
      for (let i = 0; i < 20; i++) {
        if (taskState.status === 'awaiting_approval') break;
        await new Promise((r) => setTimeout(r, 50));
        const getRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}`, {
          headers: { Authorization: `Bearer ${engine.token}` },
        });
        taskState = (await getRes.json()).task;
      }

      // Send approval with an unproposed file path
      const applyRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}/apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${engine.token}`,
        },
        body: JSON.stringify({
          approval: {
            taskId: task.taskId,
            taskVersion: taskState.version,
            proposalDigest: taskState.proposal.proposalDigest,
            decision: 'approved',
            approvedPaths: ['src/OtherFile.tsx'], // Unknown
            respondedAt: createTimestamp(),
          },
        }),
      });

      expect(applyRes.status).toBe(400);
      const applyData = await applyRes.json();
      expect(applyData.error.message).toContain('is not part of the active proposal');
    });
  });

  // =========================================================================
  // Task 4: Snippet Replacement & Snapshot Binding
  // =========================================================================
  describe('Task 4: Snippet Replacement & Snapshot Binding', () => {
    it('fails safely when oldContent is missing or empty', async () => {
      fakeRunner.queueOutput({
        summary: 'Missing oldContent',
        edits: [
          {
            path: 'src/Button.tsx',
            changeType: 'update',
            oldContent: '', // Empty old content
            newContent: 'export const BUTTON_COLOR = "red";',
            description: 'Change button',
          },
        ],
      });

      const res = await fetch(`${engine.url}/v1/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${engine.token}`,
        },
        body: JSON.stringify({
          request: {
            requestId: 'req_empty_snippet',
            prompt: 'Change button',
            requestedMode: 'manual',
            createdAt: createTimestamp(),
          },
        }),
      });

      const { task } = await res.json();
      let taskState = task;
      for (let i = 0; i < 20; i++) {
        if (taskState.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 50));
        const getRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}`, {
          headers: { Authorization: `Bearer ${engine.token}` },
        });
        taskState = (await getRes.json()).task;
      }

      expect(taskState.status).toBe('failed');
      expect(taskState.error?.message).toContain('missing or empty oldContent snippet');
    });

    it('fails safely when oldContent has multiple occurrences (ambiguous)', async () => {
      writeFileSync(
        join(tempDir, 'src/Button.tsx'),
        `const item = 'duplicate';\nconst other = 'duplicate';\n`
      );

      fakeRunner.queueOutput({
        summary: 'Ambiguous snippet',
        edits: [
          {
            path: 'src/Button.tsx',
            changeType: 'update',
            oldContent: `'duplicate'`, // Occurs twice
            newContent: `'replacement'`,
            description: 'Change duplicate',
          },
        ],
      });

      const res = await fetch(`${engine.url}/v1/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${engine.token}`,
        },
        body: JSON.stringify({
          request: {
            requestId: 'req_ambiguous_snippet',
            prompt: 'Change duplicate',
            requestedMode: 'manual',
            createdAt: createTimestamp(),
          },
        }),
      });

      const { task } = await res.json();
      let taskState = task;
      for (let i = 0; i < 20; i++) {
        if (taskState.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 50));
        const getRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}`, {
          headers: { Authorization: `Bearer ${engine.token}` },
        });
        taskState = (await getRes.json()).task;
      }

      expect(taskState.status).toBe('failed');
      expect(taskState.error?.message).toContain('is ambiguous (found 2 occurrences)');
    });

    it('rejects modifications made concurrently while Codex was generating its proposal', async () => {
      // Create a slow runner that mutates the file during planning
      const slowRunner = {
        mode: 'fake' as const,
        async propose(input: any) {
          // Mutate file during proposal generation
          writeFileSync(
            join(tempDir, 'src/Button.tsx'),
            `export const BUTTON_COLOR = 'mutated_mid_proposal';\n`
          );
          return {
            summary: 'Proposal with concurrent modification',
            edits: [
              {
                path: 'src/Button.tsx',
                changeType: 'update' as const,
                oldContent: `export const BUTTON_COLOR = 'blue';\n`,
                newContent: `export const BUTTON_COLOR = 'red';\n`,
                description: 'Update',
              },
            ],
          };
        },
      };

      const customExecutor = new TaskExecutor({
        workspaceRoot: tempDir,
        runner: slowRunner,
      });

      const task = await customExecutor.createTask({
        request: {
          requestId: 'req_concurrent_mod',
          prompt: 'Update button',
          requestedMode: 'manual',
          targetFiles: ['src/Button.tsx'],
          priority: 'normal',
          createdAt: createTimestamp(),
        },
      });

      // Wait for planning to complete
      for (let i = 0; i < 20; i++) {
        if (task.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(task.status).toBe('failed');
      expect(task.error?.code).toBe('PROPOSAL_GENERATION_FAILED');
      expect(task.error?.message).toContain('modified concurrently while proposal was being generated');
    });
  });

  // =========================================================================
  // Task 5: Safe Staged Replacement
  // =========================================================================
  describe('Task 5: Safe Staged Replacement Procedure', () => {
    it('preserves the original file untouched if write/rename fails', async () => {
      fakeRunner.queueOutput({
        summary: 'Change button color',
        edits: [
          {
            path: 'src/Button.tsx',
            changeType: 'update',
            oldContent: `export const BUTTON_COLOR = 'blue';\n`,
            newContent: `export const BUTTON_COLOR = 'red';\n`,
            description: 'Change button',
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
            requestId: 'req_stage_fail',
            prompt: 'Change button color',
            requestedMode: 'manual',
            targetFiles: ['src/Button.tsx'],
            createdAt: createTimestamp(),
          },
        }),
      });

      const { task } = await createRes.json();
      let taskState = task;
      for (let i = 0; i < 20; i++) {
        if (taskState.status === 'awaiting_approval') break;
        await new Promise((r) => setTimeout(r, 50));
        const getRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}`, {
          headers: { Authorization: `Bearer ${engine.token}` },
        });
        taskState = (await getRes.json()).task;
      }
      expect(taskState.status).toBe('awaiting_approval');

      const originalContent = readFileSync(join(tempDir, 'src/Button.tsx'), 'utf-8');

      // Make directory read-only so staging write fails
      chmodSync(join(tempDir, 'src'), 0o555);

      try {
        const applyRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}/apply`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${engine.token}`,
          },
          body: JSON.stringify({
            approval: {
              taskId: task.taskId,
              taskVersion: taskState.version,
              proposalDigest: taskState.proposal.proposalDigest,
              decision: 'approved',
              respondedAt: createTimestamp(),
            },
          }),
        });

        expect(applyRes.status).toBe(500);
      } finally {
        // Restore permissions
        chmodSync(join(tempDir, 'src'), 0o755);
      }

      // Invariant: original file must be completely untouched and intact
      const diskContent = readFileSync(join(tempDir, 'src/Button.tsx'), 'utf-8');
      expect(diskContent).toBe(originalContent);
    });
  });

  // =========================================================================
  // Task 6: Verified Source Scope
  // =========================================================================
  describe('Task 6: Verified Source Scope', () => {
    it('rejects proposed edit target outside verified sourceHints scope', async () => {
      // Codex proposes editing package.json, but verified source hint was src/Button.tsx
      fakeRunner.queueOutput({
        summary: 'Malicious edit outside source hints',
        edits: [
          {
            path: 'package.json',
            changeType: 'update',
            oldContent: JSON.stringify({ name: 'test-remediation' }),
            newContent: JSON.stringify({ name: 'hijacked-package' }),
            description: 'Edit unauthorized file',
          },
        ],
      });

      const res = await fetch(`${engine.url}/v1/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${engine.token}`,
        },
        body: JSON.stringify({
          request: {
            requestId: 'req_outside_scope',
            prompt: 'Change button',
            requestedMode: 'manual',
            targetFiles: ['package.json'], // Untrusted browser targetFiles attempt
            createdAt: createTimestamp(),
          },
          sourceHints: [
            {
              filePath: 'src/Button.tsx',
              componentName: 'Button',
            },
          ],
        }),
      });

      const { task } = await res.json();
      let taskState = task;
      for (let i = 0; i < 20; i++) {
        if (taskState.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 50));
        const getRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}`, {
          headers: { Authorization: `Bearer ${engine.token}` },
        });
        taskState = (await getRes.json()).task;
      }

      expect(taskState.status).toBe('failed');
      expect(taskState.error?.message).toContain('is outside the verified source scope');
    });
  });

  // =========================================================================
  // Task 7: RealCodexRunner Hardening
  // =========================================================================
  describe('Task 7: RealCodexRunner Hardening', () => {
    it('rejects proposals when child process exits with nonzero status code', async () => {
      const exitScript = join(tempDir, 'exit1.sh');
      writeFileSync(exitScript, '#!/bin/sh\necho "fatal error" >&2\nexit 1\n', { mode: 0o755 });
      const runner = new RealCodexRunner(exitScript);

      await expect(
        runner.propose({
          prompt: 'test prompt',
          workspaceRoot: tempDir,
        })
      ).rejects.toThrowError(/Codex process exited with code 1/);
    });

    it('rejects proposals with malformed schema (missing required fields)', async () => {
      const malformedScript = join(tempDir, 'malformed.sh');
      const malformedItem = {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: JSON.stringify({ summary: 'Missing edits field' }),
        },
      };
      writeFileSync(
        malformedScript,
        `#!/bin/sh\necho '${JSON.stringify(malformedItem)}'\nexit 0\n`,
        { mode: 0o755 }
      );
      const runner = new RealCodexRunner(malformedScript);

      await expect(
        runner.propose({
          prompt: 'test prompt',
          workspaceRoot: tempDir,
        })
      ).rejects.toThrowError(/Codex output failed schema validation/);
    });

    it('rejects proposals when process completes with no output', async () => {
      const noOutputScript = join(tempDir, 'nooutput.sh');
      writeFileSync(noOutputScript, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const runner = new RealCodexRunner(noOutputScript);

      await expect(
        runner.propose({
          prompt: 'test prompt',
          workspaceRoot: tempDir,
        })
      ).rejects.toThrowError(/Codex completed without returning valid proposal output/);
    });

    it('terminates and rejects proposals that exceed MAX_CODEX_OUTPUT_BYTES', async () => {
      const oversizedScript = join(tempDir, 'oversized.sh');
      writeFileSync(
        oversizedScript,
        `#!/bin/sh\nexec node -e "process.stdout.write(Buffer.alloc(${MAX_CODEX_OUTPUT_BYTES + 4096}, 'a'))"\n`,
        { mode: 0o755 }
      );
      const runner = new RealCodexRunner(oversizedScript);

      await expect(
        runner.propose({
          prompt: 'test prompt',
          workspaceRoot: tempDir,
        })
      ).rejects.toThrowError(/exceeded maximum output limit/);
    });
  });

  // =========================================================================
  // Task 9: Verification Integrity
  // =========================================================================
  describe('Task 9: Verification Integrity', () => {
    it('fails verification when applied code introduces a syntax error', async () => {
      fakeRunner.queueOutput({
        summary: 'Syntax error injection',
        edits: [
          {
            path: 'src/Button.tsx',
            changeType: 'update',
            oldContent: `export const BUTTON_COLOR = 'blue';\n`,
            newContent: `export const BUTTON_COLOR = 'red';\nconst unclosed = {\n`, // Syntax error!
            description: 'Inject syntax error',
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
            requestId: 'req_syntax_err',
            prompt: 'Introduce syntax error',
            requestedMode: 'manual',
            createdAt: createTimestamp(),
          },
        }),
      });

      const { task } = await createRes.json();
      let taskState = task;
      for (let i = 0; i < 20; i++) {
        if (taskState.status === 'awaiting_approval') break;
        await new Promise((r) => setTimeout(r, 50));
        const getRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}`, {
          headers: { Authorization: `Bearer ${engine.token}` },
        });
        taskState = (await getRes.json()).task;
      }

      const applyRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}/apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${engine.token}`,
        },
        body: JSON.stringify({
          approval: {
            taskId: task.taskId,
            taskVersion: taskState.version,
            proposalDigest: taskState.proposal.proposalDigest,
            decision: 'approved',
            respondedAt: createTimestamp(),
          },
        }),
      });

      // Must fail because verification failed
      expect(applyRes.status).toBe(400);
      const applyData = await applyRes.json();
      expect(applyData.error.message).toContain('Verification checks failed');
    });

    it('reports status: skipped when modifying a non-analyzable file format without verification command', async () => {
      writeFileSync(join(tempDir, 'notes.txt'), 'Initial notes\n');

      fakeRunner.queueOutput({
        summary: 'Update notes',
        edits: [
          {
            path: 'notes.txt',
            changeType: 'update',
            oldContent: 'Initial notes\n',
            newContent: 'Updated notes\n',
            description: 'Update text file',
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
            requestId: 'req_skip_verification',
            prompt: 'Update text file',
            requestedMode: 'manual',
            createdAt: createTimestamp(),
          },
        }),
      });

      const { task } = await createRes.json();
      let taskState = task;
      for (let i = 0; i < 20; i++) {
        if (taskState.status === 'awaiting_approval') break;
        await new Promise((r) => setTimeout(r, 50));
        const getRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}`, {
          headers: { Authorization: `Bearer ${engine.token}` },
        });
        taskState = (await getRes.json()).task;
      }

      const applyRes = await fetch(`${engine.url}/v1/tasks/${task.taskId}/apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${engine.token}`,
        },
        body: JSON.stringify({
          approval: {
            taskId: task.taskId,
            taskVersion: taskState.version,
            proposalDigest: taskState.proposal.proposalDigest,
            decision: 'approved',
            respondedAt: createTimestamp(),
          },
        }),
      });

      expect(applyRes.status).toBe(200);
      const applyData = await applyRes.json();
      expect(applyData.task.status).toBe('completed');
      expect(applyData.task.verification?.status).toBe('skipped');
    });
  });
});
