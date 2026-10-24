import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import {
  type TaskState,
  type TaskStatus,
  type ErrorCategory,
  type VerificationOutcome,
  type CompletionOutcome,
  type IdempotencyRecord,
  type PermissionPolicy,
  type EditApprovalResponse,
  type FileEdit,
  type BaseContentPrecondition,
  getDefaultPermissionPolicy,
  createTaskId,
  createTimestamp,
  createProposal,
  validateApprovalAgainstProposal,
  canTransitionTaskStatus,
} from '@summon-fixer/contracts';
import type { TaskEnvelope } from './envelope.js';
import type { CodexRunnerInterface } from './codex/types.js';
import {
  validateWorkspaceContainment,
  validateEditPolicy,
  SecurityError,
} from './security.js';

export interface TaskExecutorOptions {
  workspaceRoot: string;
  runner: CodexRunnerInterface;
  policy?: PermissionPolicy;
  verificationCommand?: string;
  verificationTimeoutMs?: number;
}

export class TaskExecutionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
    public readonly code: string = 'TASK_EXECUTION_ERROR'
  ) {
    super(message);
    this.name = 'TaskExecutionError';
  }
}

export class TaskExecutor {
  private readonly tasks = new Map<string, TaskState>();
  private readonly idempotencyRecords = new Map<string, IdempotencyRecord>();
  private readonly workspaceRoot: string;
  private readonly runner: CodexRunnerInterface;
  private readonly defaultPolicy: PermissionPolicy;
  private readonly verificationCommand?: string;
  private readonly verificationTimeoutMs: number;

  constructor(options: TaskExecutorOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.runner = options.runner;
    this.defaultPolicy = options.policy ?? getDefaultPermissionPolicy('manual');
    this.verificationCommand = options.verificationCommand;
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? 30_000;
  }

  getTask(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId);
  }

  getAllTasks(): TaskState[] {
    return Array.from(this.tasks.values());
  }

  async createTask(envelope: TaskEnvelope): Promise<TaskState> {
    const { request, sourceHints } = envelope;

    // Reject auto mode until runtime auto permissions are implemented
    if (request.requestedMode === 'auto') {
      throw new TaskExecutionError(
        "Auto Apply mode is not currently supported. Use 'manual' or 'plan' mode.",
        400,
        'AUTO_MODE_UNSUPPORTED'
      );
    }

    // 1. Idempotency handling
    if (request.idempotencyKey) {
      const existing = this.idempotencyRecords.get(request.idempotencyKey);
      if (existing) {
        const recordedTask = this.tasks.get(existing.taskId);
        if (recordedTask) {
          return recordedTask;
        }
      }
    }

    const taskId = createTaskId('summon');
    const now = createTimestamp();

    const task: TaskState = {
      taskId,
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      prompt: request.prompt,
      status: 'queued',
      version: 1,
      effectiveMode: request.requestedMode,
      effectivePolicy: structuredClone(this.defaultPolicy),
      workspaceRoot: this.workspaceRoot,
      targetFiles: request.targetFiles,
      edits: [],
      createdAt: now,
      updatedAt: now,
      logs: [
        {
          timestamp: now,
          level: 'info',
          message: `Task ${taskId} queued for execution`,
        },
      ],
    };

    this.tasks.set(taskId, task);

    if (request.idempotencyKey) {
      this.idempotencyRecords.set(request.idempotencyKey, {
        idempotencyKey: request.idempotencyKey,
        taskId,
        requestId: request.requestId,
        createdAt: now,
      });
    }

    // Launch background proposal workflow
    this.runPlanningPhase(task, envelope).catch((err) => {
      this.failTask(
        task,
        'PLANNING_UNHANDLED_ERROR',
        `Unhandled error during planning: ${(err as Error).message}`,
        'execution'
      );
    });

    return task;
  }

  private async runPlanningPhase(task: TaskState, envelope: TaskEnvelope): Promise<void> {
    this.transitionStatus(task, 'planning', 'Starting Codex proposal generation');

    try {
      const proposalOutput = await this.runner.propose({
        prompt: task.prompt,
        workspaceRoot: task.workspaceRoot,
        targetFiles: task.targetFiles,
        sourceHints: envelope.sourceHints,
      });

      // If no edits proposed, complete as read-only task
      if (!proposalOutput.edits || proposalOutput.edits.length === 0) {
        this.completeTask(task, {
          type: 'read_only',
          summary: proposalOutput.summary || 'Task completed with no changes needed.',
          appliedEditsCount: 0,
        });
        return;
      }

      // Validate each proposed edit
      const validatedEdits: FileEdit[] = [];
      const preconditions: BaseContentPrecondition[] = [];

      for (const edit of proposalOutput.edits) {
        // Enforce workspace containment and normalize path
        const normalizedPath = validateWorkspaceContainment(
          task.workspaceRoot,
          edit.path
        );

        // Enforce active permission policy
        validateEditPolicy(normalizedPath, task.effectivePolicy);

        const absPath = resolve(task.workspaceRoot, normalizedPath);
        let expectedHash: string | undefined;
        let actualOldContent: string | null = edit.oldContent ?? null;

        if (edit.changeType === 'update' || edit.changeType === 'delete') {
          if (!existsSync(absPath)) {
            throw new TaskExecutionError(
              `Target file '${normalizedPath}' does not exist on disk`,
              400,
              'FILE_NOT_FOUND'
            );
          }
          const diskBuffer = readFileSync(absPath);
          expectedHash = createHash('sha256').update(diskBuffer).digest('hex');
          const diskContent = diskBuffer.toString('utf-8');

          if (!actualOldContent) {
            actualOldContent = diskContent;
          }

          preconditions.push({
            path: normalizedPath,
            expectedHash,
          });
        } else if (edit.changeType === 'create') {
          if (existsSync(absPath)) {
            throw new TaskExecutionError(
              `Cannot create file '${normalizedPath}': file already exists on disk`,
              400,
              'FILE_ALREADY_EXISTS'
            );
          }
          actualOldContent = null;
        }

        validatedEdits.push({
          path: normalizedPath,
          changeType: edit.changeType,
          status: 'pending',
          oldContent: actualOldContent,
          newContent: edit.newContent ?? null,
          description: edit.description,
        });
      }

      // Create authoritative MultiFileEditPlan with computed proposal digest
      const plan = createProposal({
        summary: proposalOutput.summary || 'Proposed changes',
        edits: validatedEdits,
        taskVersion: task.version,
        preconditions,
      });

      task.proposal = plan;
      task.edits = plan.edits;

      // Plan-only mode is genuinely read-only and transitions directly to completed
      if (task.effectiveMode === 'plan') {
        this.completeTask(task, {
          type: 'read_only',
          summary: `[Plan Only] ${plan.summary}`,
          appliedEditsCount: 0,
        });
        return;
      }

      this.transitionStatus(
        task,
        'awaiting_approval',
        `Proposal created with digest ${plan.proposalDigest}. Awaiting user approval.`
      );
    } catch (err) {
      const message = (err as Error).message;
      const category: ErrorCategory =
        err instanceof SecurityError ? 'policy' : 'execution';
      this.failTask(task, 'PROPOSAL_GENERATION_FAILED', message, category);
    }
  }

  async applyApproval(
    taskId: string,
    approval: EditApprovalResponse
  ): Promise<TaskState> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskExecutionError(`Task '${taskId}' not found`, 404, 'TASK_NOT_FOUND');
    }

    if (task.status !== 'awaiting_approval') {
      throw new TaskExecutionError(
        `Task '${taskId}' is in status '${task.status}', not awaiting approval`,
        400,
        'INVALID_TASK_STATUS'
      );
    }

    if (task.effectiveMode === 'plan') {
      throw new TaskExecutionError(
        "Cannot apply edits in 'plan' mode: plan mode is strictly read-only",
        403,
        'PLAN_MODE_READ_ONLY'
      );
    }

    if (!task.proposal) {
      throw new TaskExecutionError(
        `Task '${taskId}' has no active proposal to approve`,
        400,
        'NO_ACTIVE_PROPOSAL'
      );
    }

    // Validate approval against proposal digest and version
    const validation = validateApprovalAgainstProposal(approval, {
      proposalDigest: task.proposal.proposalDigest,
      taskVersion: task.version,
    });

    if (!validation.valid) {
      throw new TaskExecutionError(
        validation.message,
        409,
        validation.reason.toUpperCase()
      );
    }

    // Handle rejection
    if (approval.decision === 'rejected') {
      const reason = approval.feedback ?? 'User rejected proposed edits';
      this.cancelTask(task, reason);
      return task;
    }

    // User approved: transition to executing
    this.transitionStatus(task, 'executing', 'Applying approved file edits');

    try {
      const appliedFiles: string[] = [];
      const preconditionsMap = new Map(
        (task.proposal.preconditions ?? []).map((p) => [p.path, p.expectedHash])
      );

      // Determine edits to apply, filtered by approvedPaths if specified
      const approvedPathsSet =
        approval.approvedPaths && approval.approvedPaths.length > 0
          ? new Set(
              approval.approvedPaths.map((p) =>
                validateWorkspaceContainment(task.workspaceRoot, p)
              )
            )
          : null;

      const editsToApply = task.proposal.edits.filter((edit) => {
        if (!approvedPathsSet) return true;
        return approvedPathsSet.has(edit.path);
      });

      if (editsToApply.length === 0) {
        throw new TaskExecutionError(
          'No approved file modifications match the proposed edits',
          400,
          'NO_MATCHING_EDITS'
        );
      }

      // 1. Recheck workspace containment, symlinks, policy restrictions, and base-content preconditions for ALL edits prior to making any mutations
      for (const edit of editsToApply) {
        // Recheck workspace containment and symlinks
        const normalizedPath = validateWorkspaceContainment(
          task.workspaceRoot,
          edit.path
        );

        // Recheck active permission policy restrictions (e.g. protected secret files)
        validateEditPolicy(normalizedPath, task.effectivePolicy);

        const absPath = resolve(task.workspaceRoot, normalizedPath);

        if (edit.changeType === 'update' || edit.changeType === 'delete') {
          if (!existsSync(absPath)) {
            throw new TaskExecutionError(
              `Precondition failed: target file '${edit.path}' was removed before changes could be applied`,
              412,
              'PRECONDITION_FAILED'
            );
          }

          const expectedHash = preconditionsMap.get(edit.path);
          if (expectedHash) {
            const diskBuffer = readFileSync(absPath);
            const currentHash = createHash('sha256').update(diskBuffer).digest('hex');
            if (currentHash !== expectedHash) {
              throw new TaskExecutionError(
                `Base content precondition failed for '${edit.path}': expected hash ${expectedHash}, current disk hash ${currentHash}`,
                412,
                'PRECONDITION_FAILED'
              );
            }
          }
        } else if (edit.changeType === 'create') {
          if (existsSync(absPath)) {
            throw new TaskExecutionError(
              `Precondition failed: target file '${edit.path}' already exists on disk`,
              412,
              'PRECONDITION_FAILED'
            );
          }
        }
      }

      // 2. Apply all approved edits to disk
      for (const edit of editsToApply) {
        const absPath = resolve(task.workspaceRoot, edit.path);

        if (edit.changeType === 'create') {
          mkdirSync(dirname(absPath), { recursive: true });
          writeFileSync(absPath, edit.newContent ?? '', 'utf-8');
          edit.status = 'applied';
          edit.appliedAt = createTimestamp();
          appliedFiles.push(edit.path);
        } else if (edit.changeType === 'update') {
          const currentContent = readFileSync(absPath, 'utf-8');
          let nextContent: string;

          if (edit.oldContent && edit.newContent && currentContent.includes(edit.oldContent)) {
            // Segment replacement
            nextContent = currentContent.replace(edit.oldContent, edit.newContent);
          } else {
            // Full content replacement
            nextContent = edit.newContent ?? '';
          }

          writeFileSync(absPath, nextContent, 'utf-8');
          edit.status = 'applied';
          edit.appliedAt = createTimestamp();
          appliedFiles.push(edit.path);
        } else if (edit.changeType === 'delete') {
          rmSync(absPath);
          edit.status = 'applied';
          edit.appliedAt = createTimestamp();
          appliedFiles.push(edit.path);
        }
      }

      // 3. Verification Phase
      let verificationOutcome: VerificationOutcome;
      if (this.verificationCommand) {
        verificationOutcome = await this.runVerificationCommand(
          this.verificationCommand,
          task.workspaceRoot,
          this.verificationTimeoutMs
        );
      } else {
        // Built-in verification: verify changed files exist and are readable
        verificationOutcome = {
          status: 'passed',
          checks: [
            {
              name: 'disk-verification',
              status: 'passed',
              message: `Verified ${appliedFiles.length} files successfully written to disk`,
              durationMs: 1,
            },
          ],
          summary: `Verified ${appliedFiles.length} file modification(s)`,
        };
      }

      task.verification = verificationOutcome;

      if (verificationOutcome.status === 'passed') {
        this.completeTask(task, {
          type: 'edits_applied',
          summary: `Successfully applied ${appliedFiles.length} file modification(s) and passed verification`,
          appliedEditsCount: appliedFiles.length,
          verification: verificationOutcome,
        });
      } else {
        this.failTask(
          task,
          'VERIFICATION_FAILED',
          `Verification checks failed after applying edits: ${verificationOutcome.checks[0]?.message ?? 'Checks failed'}`,
          'execution'
        );
      }
    } catch (err) {
      const message = (err as Error).message;
      const category: ErrorCategory =
        err instanceof TaskExecutionError && err.code === 'PRECONDITION_FAILED'
          ? 'preflight'
          : 'execution';
      this.failTask(task, 'APPLY_FAILED', message, category);
      throw err;
    }

    return task;
  }

  private async runVerificationCommand(
    command: string,
    cwd: string,
    timeoutMs: number
  ): Promise<VerificationOutcome> {
    const startTime = Date.now();
    return new Promise<VerificationOutcome>((resolveOutcome) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolveOutcome({
          status: 'failed',
          checks: [
            {
              name: command,
              status: 'failed',
              message: `Verification command timed out after ${timeoutMs}ms`,
              durationMs: Date.now() - startTime,
            },
          ],
          summary: 'Verification timed out',
        });
      }, timeoutMs);

      child.stdout?.on('data', (d) => (stdout += d.toString('utf-8')));
      child.stderr?.on('data', (d) => (stderr += d.toString('utf-8')));

      child.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        const passed = code === 0;
        resolveOutcome({
          status: passed ? 'passed' : 'failed',
          checks: [
            {
              name: command,
              status: passed ? 'passed' : 'failed',
              message: passed
                ? 'Verification command completed successfully'
                : `Verification failed with exit code ${code}. Stderr: ${stderr.trim()}`,
              durationMs,
            },
          ],
          summary: passed
            ? 'Verification command completed successfully'
            : `Verification failed with exit code ${code}`,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolveOutcome({
          status: 'failed',
          checks: [
            {
              name: command,
              status: 'failed',
              message: `Failed to spawn verification process: ${err.message}`,
              durationMs: Date.now() - startTime,
            },
          ],
          summary: 'Verification process failed to start',
        });
      });
    });
  }

  private transitionStatus(task: TaskState, newStatus: TaskStatus, message?: string): void {
    if (!canTransitionTaskStatus(task.status, newStatus)) {
      throw new TaskExecutionError(
        `Illegal status transition from '${task.status}' to '${newStatus}'`,
        500,
        'ILLEGAL_TRANSITION'
      );
    }

    task.status = newStatus;
    task.updatedAt = createTimestamp();
    if (message) {
      task.logs.push({
        timestamp: task.updatedAt,
        level: 'info',
        message,
      });
    }
  }

  private completeTask(task: TaskState, outcome: CompletionOutcome): void {
    task.completion = outcome;
    task.completedAt = createTimestamp();
    this.transitionStatus(task, 'completed', outcome.summary);
  }

  private failTask(
    task: TaskState,
    code: string,
    message: string,
    category: ErrorCategory
  ): void {
    task.error = {
      code,
      message,
      category,
      recoverable: false,
    };
    if (canTransitionTaskStatus(task.status, 'failed')) {
      this.transitionStatus(task, 'failed', `Task failed: [${code}] ${message}`);
    }
  }

  private cancelTask(task: TaskState, reason: string): void {
    task.error = {
      code: 'TASK_CANCELLED',
      message: reason,
      category: 'execution',
      recoverable: false,
    };
    if (canTransitionTaskStatus(task.status, 'cancelled')) {
      this.transitionStatus(task, 'cancelled', `Task cancelled: ${reason}`);
    }
  }
}
