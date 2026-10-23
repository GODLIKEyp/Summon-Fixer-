import { describe, it, expect } from 'vitest';
import {
  TaskRequestSchema,
  TaskStateSchema,
  FileEditSchema,
  MultiFileEditPlanSchema,
  EditApprovalResponseSchema,
  validateTaskRequest,
  safeValidateTaskRequest,
  validateApprovalAgainstProposal,
  isPathAllowedByPolicy,
  getDefaultPermissionPolicy,
  canTransitionTaskStatus,
  validateEventForStatus,
  normalizeWorkspacePath,
  computeProposalDigest,
  createProposal,
  TaskErrorSchema,
  CompletionOutcomeSchema,
} from '../index.js';

describe('Astra Audit Corrections: Input Validation & Bounds (Item 1 & 6)', () => {
  it('rejects empty or whitespace-only prompt', () => {
    expect(() =>
      validateTaskRequest({
        requestId: 'req_1',
        prompt: '',
        createdAt: new Date().toISOString(),
      })
    ).toThrow(/Prompt cannot be empty/);

    expect(() =>
      validateTaskRequest({
        requestId: 'req_2',
        prompt: '   \n\t   ',
        createdAt: new Date().toISOString(),
      })
    ).toThrow(/Prompt cannot be empty/);
  });

  it('rejects prompts exceeding 10,000 characters', () => {
    const hugePrompt = 'x'.repeat(10_001);
    expect(() =>
      validateTaskRequest({
        requestId: 'req_3',
        prompt: hugePrompt,
        createdAt: new Date().toISOString(),
      })
    ).toThrow(/exceeds maximum length/);
  });

  it('ensures browser TaskRequest does not allow policy overrides or workspaceRoot', () => {
    const rawClientPayload = {
      requestId: 'req_4',
      prompt: 'Refactor navbar',
      createdAt: new Date().toISOString(),
      // Attempting to inject policy overrides and workspaceRoot as untrusted client
      permissionPolicy: {
        mode: 'auto',
        allowedPaths: ['/'],
        allowShellExecution: true,
        allowFileDeletion: true,
      },
      workspaceRoot: '/etc',
    };

    const parsed = validateTaskRequest(rawClientPayload);

    // Schema must not expose client-injected permissionPolicy or workspaceRoot
    expect((parsed as Record<string, unknown>).permissionPolicy).toBeUndefined();
    expect((parsed as Record<string, unknown>).workspaceRoot).toBeUndefined();
  });

  it('validates opaque sourceId and revision selection in FileContext', () => {
    const request = validateTaskRequest({
      requestId: 'req_5',
      prompt: 'Check buffer',
      createdAt: new Date().toISOString(),
      context: {
        activeFile: {
          path: 'src/App.tsx',
          sourceId: 'vscode-tab-buffer-42',
          revision: 'git-commit-abc1234',
        },
        sourceSelection: {
          sourceId: 'git-worktree',
          revision: 'rev_987',
          description: 'Local dirty branch',
        },
      },
    });

    expect(request.context?.activeFile?.sourceId).toBe('vscode-tab-buffer-42');
    expect(request.context?.activeFile?.revision).toBe('git-commit-abc1234');
    expect(request.context?.sourceSelection?.sourceId).toBe('git-worktree');
  });
});

describe('Astra Audit Corrections: Proposal Binding & Stale Approvals (Item 2)', () => {
  it('rejects approval when task version is stale', () => {
    const approval = EditApprovalResponseSchema.parse({
      taskId: 'task_001',
      taskVersion: 1, // Stale version
      proposalDigest: 'digest_match_123',
      decision: 'approved',
      respondedAt: new Date().toISOString(),
    });

    const activeProposal = {
      taskVersion: 2, // Incremented version
      proposalDigest: 'digest_match_123',
    };

    const result = validateApprovalAgainstProposal(approval, activeProposal);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('stale_version');
      expect(result.message).toContain('does not match current task version');
    }
  });

  it('rejects approval when proposal digest does not match', () => {
    const approval = EditApprovalResponseSchema.parse({
      taskId: 'task_001',
      taskVersion: 2,
      proposalDigest: 'tampered_digest_abc',
      decision: 'approved',
      respondedAt: new Date().toISOString(),
    });

    const activeProposal = {
      taskVersion: 2,
      proposalDigest: 'authentic_digest_xyz',
    };

    const result = validateApprovalAgainstProposal(approval, activeProposal);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('digest_mismatch');
      expect(result.message).toContain('does not match active proposal digest');
    }
  });

  it('accepts approval when task version and digest match exactly', () => {
    const approval = EditApprovalResponseSchema.parse({
      taskId: 'task_001',
      taskVersion: 3,
      proposalDigest: 'exact_digest_456',
      decision: 'approved',
      respondedAt: new Date().toISOString(),
    });

    const activeProposal = {
      taskVersion: 3,
      proposalDigest: 'exact_digest_456',
    };

    const result = validateApprovalAgainstProposal(approval, activeProposal);
    expect(result.valid).toBe(true);
  });
});

describe('Astra Audit Corrections: Path Traversal & Contradictory Edits (Item 3)', () => {
  it('rejects path traversal with .. in path normalization', () => {
    expect(() => normalizeWorkspacePath('../secret.txt')).toThrow(/traversal/i);
    expect(() => normalizeWorkspacePath('src/../../etc/passwd')).toThrow(/traversal/i);
    expect(() => normalizeWorkspacePath('/absolute/path')).toThrow(/absolute/i);
  });

  it('rejects duplicate normalized paths in a multi-file proposal', () => {
    expect(() =>
      MultiFileEditPlanSchema.parse({
        summary: 'Duplicate edit test',
        edits: [
          {
            path: 'src/utils/math.ts',
            changeType: 'create',
            newContent: 'export const add = (a, b) => a + b;',
          },
          {
            path: './src//utils/math.ts', // Resolves to identical normalized path
            changeType: 'create',
            newContent: 'export const sub = (a, b) => a - b;',
          },
        ],
        totalFiles: 2,
      })
    ).toThrow(/Duplicate normalized file path/);
  });

  it('rejects inconsistent totalFiles count in a proposal', () => {
    expect(() =>
      MultiFileEditPlanSchema.parse({
        summary: 'Inconsistent count',
        edits: [
          {
            path: 'src/index.ts',
            changeType: 'create',
            newContent: 'console.log("hello");',
          },
        ],
        totalFiles: 5, // edts.length is 1, not 5
      })
    ).toThrow(/Inconsistent file count/);
  });

  it('rejects contradictory edit: create with non-null oldContent', () => {
    expect(() =>
      FileEditSchema.parse({
        path: 'src/new-file.ts',
        changeType: 'create',
        oldContent: 'existing text', // Contradictory for create
        newContent: 'new text',
      })
    ).toThrow(/Contradictory edit/);
  });

  it('rejects contradictory edit: create with null newContent', () => {
    expect(() =>
      FileEditSchema.parse({
        path: 'src/new-file.ts',
        changeType: 'create',
        newContent: null, // Contradictory for create
      })
    ).toThrow(/Contradictory edit/);
  });

  it('rejects contradictory edit: delete with non-null newContent', () => {
    expect(() =>
      FileEditSchema.parse({
        path: 'src/old-file.ts',
        changeType: 'delete',
        newContent: 'should not exist after delete', // Contradictory for delete
      })
    ).toThrow(/Contradictory edit/);
  });

  it('rejects contradictory edit: update with identical oldContent and newContent (no-op)', () => {
    expect(() =>
      FileEditSchema.parse({
        path: 'src/same.ts',
        changeType: 'update',
        oldContent: 'unchanged text',
        newContent: 'unchanged text', // No-op
      })
    ).toThrow(/Contradictory edit.*identical/);
  });

  it('rejects contradictory edit: update with neither newContent nor patch', () => {
    expect(() =>
      FileEditSchema.parse({
        path: 'src/empty-update.ts',
        changeType: 'update',
      })
    ).toThrow(/must provide at least newContent or patch/);
  });
});

describe('Astra Audit Corrections: Policy Defaults & Env Protection (Item 4 & 8)', () => {
  it('protects .env.* secrets while allowing .env.example', () => {
    const policy = getDefaultPermissionPolicy('manual');

    // .env.example is explicitly safe and permitted
    expect(isPathAllowedByPolicy('.env.example', policy)).toBe(true);
    expect(isPathAllowedByPolicy('subfolder/.env.example', policy)).toBe(true);

    // .env and all secret variants are strictly forbidden
    expect(isPathAllowedByPolicy('.env', policy)).toBe(false);
    expect(isPathAllowedByPolicy('.env.local', policy)).toBe(false);
    expect(isPathAllowedByPolicy('.env.production', policy)).toBe(false);
    expect(isPathAllowedByPolicy('.env.development.local', policy)).toBe(false);

    // git and node_modules forbidden
    expect(isPathAllowedByPolicy('.git/HEAD', policy)).toBe(false);
    expect(isPathAllowedByPolicy('node_modules/zod/package.json', policy)).toBe(false);
  });

  it('guarantees baseline configuration is independently cloned and frozen', () => {
    const policy = getDefaultPermissionPolicy('plan');
    policy.allowedPaths.push('corrupted/path');

    const freshPolicy = getDefaultPermissionPolicy('plan');
    expect(freshPolicy.allowedPaths).toEqual(['.']);
  });
});

describe('Astra Audit Corrections: Unified State Transitions & Outcomes (Item 5)', () => {
  it('supports preflight failure transition from queued and planning', () => {
    expect(canTransitionTaskStatus('queued', 'failed')).toBe(true);
    expect(canTransitionTaskStatus('planning', 'failed')).toBe(true);

    const preflightError = TaskErrorSchema.parse({
      category: 'preflight',
      code: 'ERR_PREFLIGHT_DIRTY_TREE',
      message: 'Workspace has uncommitted changes that conflict with task targets',
      recoverable: true,
    });

    expect(preflightError.category).toBe('preflight');
    expect(preflightError.code).toBe('ERR_PREFLIGHT_DIRTY_TREE');
  });

  it('supports read-only completion from planning mode', () => {
    expect(canTransitionTaskStatus('planning', 'completed')).toBe(true);

    const outcome = CompletionOutcomeSchema.parse({
      type: 'read_only',
      summary: 'Architectural analysis complete. No edits requested.',
      appliedEditsCount: 0,
      verification: {
        status: 'skipped',
        checks: [],
      },
    });

    expect(outcome.type).toBe('read_only');
    expect(outcome.appliedEditsCount).toBe(0);
  });

  it('rejects illegal events for task status', () => {
    const timestamp = new Date().toISOString();

    // Cannot apply edits while queued
    const editsEvent = {
      type: 'task:edits_applied' as const,
      taskId: 'task_x',
      timestamp,
      edits: [],
    };
    const check1 = validateEventForStatus('queued', editsEvent);
    expect(check1.valid).toBe(false);
    if (!check1.valid) {
      expect(check1.reason).toContain("must be 'executing'");
    }

    // Cannot process events on cancelled or completed tasks
    const progressEvent = {
      type: 'task:progress' as const,
      taskId: 'task_x',
      timestamp,
      progress: {
        step: 1,
        phase: 'executing',
        message: 'still working',
      },
    };
    const check2 = validateEventForStatus('cancelled', progressEvent);
    expect(check2.valid).toBe(false);
    if (!check2.valid) {
      expect(check2.reason).toContain('terminal status');
    }
  });
});
