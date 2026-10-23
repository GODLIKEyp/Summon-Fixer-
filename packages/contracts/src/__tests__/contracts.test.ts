import { describe, it, expect } from 'vitest';
import {
  // Permissions
  PermissionModeSchema,
  PermissionPolicySchema,
  getDefaultPermissionPolicy,
  isPathAllowedByPolicy,
  // Edits
  FileEditSchema,
  MultiFileEditPlanSchema,
  EditApprovalResponseSchema,
  computeProposalDigest,
  createProposal,
  // Context
  TaskContextSchema,
  // Tasks
  TaskStatusSchema,
  TaskRequestSchema,
  TaskStateSchema,
  // Events
  TaskEventSchema,
  // Validators
  validateTaskRequest,
  safeValidateTaskRequest,
  validateTaskState,
  safeValidateTaskState,
  validateFileEdit,
  validateMultiFileEditPlan,
  validateApprovalAgainstProposal,
  isTerminalTaskStatus,
  canTransitionTaskStatus,
  validateEventForStatus,
  createTaskId,
  createRequestId,
  createTimestamp,
} from '../index.js';

describe('Contracts: Permissions', () => {
  it('should accept valid permission modes', () => {
    expect(PermissionModeSchema.parse('plan')).toBe('plan');
    expect(PermissionModeSchema.parse('manual')).toBe('manual');
    expect(PermissionModeSchema.parse('auto')).toBe('auto');
  });

  it('should reject invalid permission modes', () => {
    expect(() => PermissionModeSchema.parse('superuser')).toThrow();
    expect(() => PermissionModeSchema.parse('')).toThrow();
  });

  it('should apply defaults for permission policies', () => {
    const policy = PermissionPolicySchema.parse({});
    expect(policy.mode).toBe('plan');
    expect(policy.allowedPaths).toEqual(['.']);
    expect(policy.allowShellExecution).toBe(false);
    expect(policy.allowFileCreation).toBe(true);
    expect(policy.allowFileDeletion).toBe(false);
    expect(policy.maxFilesPerTask).toBe(10);
    expect(policy.requireDiffApproval).toBe(true);
  });

  it('should retrieve distinct default policies per mode with immutable baselines', () => {
    const planPolicy = getDefaultPermissionPolicy('plan');
    const manualPolicy = getDefaultPermissionPolicy('manual');
    const autoPolicy = getDefaultPermissionPolicy('auto');

    expect(planPolicy.mode).toBe('plan');
    expect(planPolicy.allowFileCreation).toBe(false);

    expect(manualPolicy.mode).toBe('manual');
    expect(manualPolicy.allowFileCreation).toBe(true);
    expect(manualPolicy.requireDiffApproval).toBe(true);

    expect(autoPolicy.mode).toBe('auto');
    expect(autoPolicy.requireDiffApproval).toBe(false);

    // Modifying returned clone must not mutate the baseline
    planPolicy.allowedPaths.push('hacked');
    const freshPlan = getDefaultPermissionPolicy('plan');
    expect(freshPlan.allowedPaths).toEqual(['.']);
  });

  it('should allow .env.example while strictly protecting .env and .env.* secret files', () => {
    const policy = getDefaultPermissionPolicy('manual');

    // .env.example must be allowed
    expect(isPathAllowedByPolicy('.env.example', policy)).toBe(true);
    expect(isPathAllowedByPolicy('packages/app/.env.example', policy)).toBe(true);

    // .env and secret variants must be rejected
    expect(isPathAllowedByPolicy('.env', policy)).toBe(false);
    expect(isPathAllowedByPolicy('.env.local', policy)).toBe(false);
    expect(isPathAllowedByPolicy('.env.production', policy)).toBe(false);
    expect(isPathAllowedByPolicy('.env.staging', policy)).toBe(false);
    expect(isPathAllowedByPolicy('apps/web/.env.local', policy)).toBe(false);

    // git and node_modules must be rejected
    expect(isPathAllowedByPolicy('.git/config', policy)).toBe(false);
    expect(isPathAllowedByPolicy('node_modules/pkg/index.js', policy)).toBe(false);
  });
});

describe('Contracts: Multi-File Edits', () => {
  it('should validate single file edit specifications', () => {
    const edit = validateFileEdit({
      path: 'src/components/Header.tsx',
      changeType: 'update',
      description: 'Fix mobile responsiveness in header',
      oldContent: 'const Header = () => <div>Header</div>;',
      newContent: 'const Header = () => <header className="mobile-nav">Header</header>;',
      patch: '--- a/src/components/Header.tsx\n+++ b/src/components/Header.tsx',
    });

    expect(edit.path).toBe('src/components/Header.tsx');
    expect(edit.changeType).toBe('update');
    expect(edit.status).toBe('pending');
  });

  it('should validate multi-file edit plans with consistent file counts', () => {
    const plan = validateMultiFileEditPlan({
      proposalId: 'prop_001',
      taskVersion: 1,
      summary: 'Refactor auth state across context and hook',
      explanation: 'Extracted token refresh logic into separate utility.',
      edits: [
        {
          path: 'src/context/AuthContext.tsx',
          changeType: 'update',
          description: 'Add token refresh provider',
          newContent: 'export function AuthContext() {}',
          status: 'pending',
        },
        {
          path: 'src/utils/token.ts',
          changeType: 'create',
          description: 'New token refresh utility',
          newContent: 'export function refreshToken() {}',
          status: 'pending',
        },
      ],
      totalFiles: 2,
    });

    expect(plan.edits).toHaveLength(2);
    expect(plan.edits[0].path).toBe('src/context/AuthContext.tsx');
    expect(plan.edits[1].changeType).toBe('create');
  });

  it('should validate user approval responses with bound digest and version', () => {
    const approval = EditApprovalResponseSchema.parse({
      taskId: 'task_123',
      taskVersion: 1,
      proposalDigest: 'a1b2c3d4e5f67890',
      decision: 'approved',
      approvedPaths: ['src/context/AuthContext.tsx'],
      feedback: 'Skip token utility for now',
      respondedAt: new Date().toISOString(),
    });

    expect(approval.decision).toBe('approved');
    expect(approval.approvedPaths).toEqual(['src/context/AuthContext.tsx']);
    expect(approval.taskVersion).toBe(1);
    expect(approval.proposalDigest).toBe('a1b2c3d4e5f67890');
  });

  it('should compute deterministic proposal digests', () => {
    const edits = [
      {
        path: 'src/b.ts',
        changeType: 'create' as const,
        newContent: 'const b = 2;',
      },
      {
        path: 'src/a.ts',
        changeType: 'create' as const,
        newContent: 'const a = 1;',
      },
    ];

    const digest1 = computeProposalDigest(edits, 1);
    // Reverse array order; digest must be identical because paths are canonically sorted
    const digest2 = computeProposalDigest([edits[1], edits[0]], 1);

    expect(digest1).toBe(digest2);
    expect(typeof digest1).toBe('string');
    expect(digest1.length).toBe(64);
  });
});

describe('Contracts: Task Request and Status', () => {
  it('should validate a complete untrusted TaskRequest with client requestId', () => {
    const validTimestamp = new Date().toISOString();
    const request = validateTaskRequest({
      requestId: 'req_001',
      idempotencyKey: 'idem_key_abc',
      prompt: 'Fix button overflow on mobile viewport',
      requestedMode: 'plan',
      targetFiles: ['src/components/Button.tsx', 'src/styles/button.css'],
      context: {
        activeFile: {
          path: 'src/components/Button.tsx',
          sourceId: 'editor_buffer_1',
          revision: 'rev_git_sha',
          lineRange: { start: 10, end: 25 },
        },
        sourceSelection: {
          sourceId: 'git_main',
          revision: '42fb357',
        },
        ui: {
          componentName: 'Button',
          elementSelector: 'button.btn-primary',
          renderedUrl: 'http://localhost:5173/checkout',
        },
        client: {
          clientType: 'overlay',
          gitBranch: 'main',
        },
      },
      createdAt: validTimestamp,
    });

    expect(request.requestId).toBe('req_001');
    expect(request.prompt).toBe('Fix button overflow on mobile viewport');
    expect(request.requestedMode).toBe('plan');
    expect(request.targetFiles).toHaveLength(2);
    expect(request.context?.activeFile?.sourceId).toBe('editor_buffer_1');
  });

  it('should safely reject an invalid TaskRequest with empty or whitespace-only prompt', () => {
    const result = safeValidateTaskRequest({
      requestId: '',
      prompt: '   ',
      createdAt: 'invalid-date',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('should validate an authoritative TaskState snapshot with engine-owned fields', () => {
    const now = createTimestamp();
    const policy = getDefaultPermissionPolicy('manual');
    const state = validateTaskState({
      taskId: 'task_002',
      requestId: 'req_002',
      version: 1,
      workspaceRoot: '/Users/test/project',
      effectivePolicy: policy,
      effectiveMode: 'manual',
      prompt: 'Add dark mode toggle',
      status: 'awaiting_approval',
      progress: {
        step: 2,
        totalSteps: 3,
        phase: 'planning',
        message: 'Diff proposed, awaiting approval',
        percentage: 66,
      },
      proposal: {
        proposalId: 'prop_002',
        taskVersion: 1,
        proposalDigest: 'digest_123',
        summary: 'Add DarkModeToggle component and update theme provider',
        edits: [
          {
            path: 'src/components/DarkModeToggle.tsx',
            changeType: 'create',
            newContent: 'export const DarkModeToggle = () => null;',
            status: 'pending',
          },
        ],
        totalFiles: 1,
      },
      edits: [
        {
          path: 'src/components/DarkModeToggle.tsx',
          changeType: 'create',
          newContent: 'export const DarkModeToggle = () => null;',
          status: 'pending',
        },
      ],
      createdAt: now,
      updatedAt: now,
      logs: [
        {
          timestamp: now,
          level: 'info',
          message: 'Task initiated in manual mode',
        },
      ],
    });

    expect(state.taskId).toBe('task_002');
    expect(state.workspaceRoot).toBe('/Users/test/project');
    expect(state.status).toBe('awaiting_approval');
    expect(state.proposal?.edits).toHaveLength(1);
    expect(state.logs).toHaveLength(1);
  });
});

describe('Contracts: Task Status Transitions & Terminal Checks', () => {
  it('should identify terminal statuses correctly', () => {
    expect(isTerminalTaskStatus('completed')).toBe(true);
    expect(isTerminalTaskStatus('failed')).toBe(true);
    expect(isTerminalTaskStatus('cancelled')).toBe(true);

    expect(isTerminalTaskStatus('queued')).toBe(false);
    expect(isTerminalTaskStatus('planning')).toBe(false);
    expect(isTerminalTaskStatus('awaiting_approval')).toBe(false);
    expect(isTerminalTaskStatus('executing')).toBe(false);
  });

  it('should validate legal transitions including preflight failure and read-only completion', () => {
    // Normal lifecycle
    expect(canTransitionTaskStatus('queued', 'planning')).toBe(true);
    expect(canTransitionTaskStatus('planning', 'awaiting_approval')).toBe(true);
    expect(canTransitionTaskStatus('awaiting_approval', 'executing')).toBe(true);
    expect(canTransitionTaskStatus('executing', 'completed')).toBe(true);

    // Preflight failure directly from queued or planning
    expect(canTransitionTaskStatus('queued', 'failed')).toBe(true);
    expect(canTransitionTaskStatus('planning', 'failed')).toBe(true);

    // Read-only completion from planning mode
    expect(canTransitionTaskStatus('planning', 'completed')).toBe(true);

    // Terminal statuses cannot transition
    expect(canTransitionTaskStatus('completed', 'executing')).toBe(false);
    expect(canTransitionTaskStatus('failed', 'planning')).toBe(false);

    // Illegal skip
    expect(canTransitionTaskStatus('queued', 'completed')).toBe(false);
  });

  it('should validate events against current task status', () => {
    const timestamp = createTimestamp();
    const completedEvent = {
      type: 'task:completed' as const,
      taskId: 'task_1',
      timestamp,
      outcome: {
        type: 'read_only' as const,
        summary: 'Read-only analysis complete',
        appliedEditsCount: 0,
      },
      edits: [],
    };

    // Valid when planning (read-only completion) or executing
    expect(validateEventForStatus('planning', completedEvent).valid).toBe(true);
    expect(validateEventForStatus('executing', completedEvent).valid).toBe(true);

    // Invalid when queued or completed
    expect(validateEventForStatus('queued', completedEvent).valid).toBe(false);
    expect(validateEventForStatus('completed', completedEvent).valid).toBe(false);
  });
});

describe('Contracts: Real-Time Event Schemas', () => {
  it('should validate task:created event', () => {
    const timestamp = createTimestamp();
    const event = TaskEventSchema.parse({
      type: 'task:created',
      taskId: 'task_event_1',
      requestId: 'req_event_1',
      timestamp,
      request: {
        requestId: 'req_event_1',
        prompt: 'Inspect layout shift',
        requestedMode: 'plan',
        createdAt: timestamp,
      },
    });

    expect(event.type).toBe('task:created');
    if (event.type === 'task:created') {
      expect(event.requestId).toBe('req_event_1');
    }
  });

  it('should validate task:approval_requested event with proposalDigest', () => {
    const timestamp = createTimestamp();
    const event = TaskEventSchema.parse({
      type: 'task:approval_requested',
      taskId: 'task_event_2',
      taskVersion: 1,
      proposalDigest: 'digest_abcdef123456',
      timestamp,
      proposal: {
        proposalId: 'prop_003',
        taskVersion: 1,
        proposalDigest: 'digest_abcdef123456',
        summary: 'Update CSS grid layout',
        edits: [
          {
            path: 'src/styles/grid.css',
            changeType: 'update',
            newContent: '.grid { display: grid; }',
            status: 'pending',
          },
        ],
        totalFiles: 1,
      },
      timeoutMs: 60000,
    });

    expect(event.type).toBe('task:approval_requested');
    if (event.type === 'task:approval_requested') {
      expect(event.proposalDigest).toBe('digest_abcdef123456');
    }
  });
});

describe('Contracts: Utilities', () => {
  it('should generate formatted unique task and request IDs', () => {
    const taskId = createTaskId();
    const reqId = createRequestId();

    expect(taskId.startsWith('task_')).toBe(true);
    expect(reqId.startsWith('req_')).toBe(true);
    expect(taskId).not.toBe(reqId);
  });

  it('should generate valid ISO timestamps', () => {
    const ts = createTimestamp();
    expect(new Date(ts).toISOString()).toBe(ts);
  });
});
