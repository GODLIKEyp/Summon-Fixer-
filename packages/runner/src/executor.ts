import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  lstatSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import ts from 'typescript';
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

/**
 * Counts non-overlapping occurrences of a substring within a text.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle || !haystack) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
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

    // Release policy constraint: restrict this release to 1 existing-file update
    const effectivePolicy = structuredClone(this.defaultPolicy);
    effectivePolicy.allowFileCreation = false;
    effectivePolicy.allowFileDeletion = false;
    effectivePolicy.maxFilesPerTask = 1;

    // Verified Source Scope:
    // If sourceHints are provided, trust and enforce them as targetFiles
    let validatedTargetFiles: string[] | undefined;
    if (sourceHints && sourceHints.length > 0) {
      validatedTargetFiles = sourceHints.map((hint) =>
        validateWorkspaceContainment(this.workspaceRoot, hint.filePath)
      );
    } else if (request.targetFiles && request.targetFiles.length > 0) {
      validatedTargetFiles = request.targetFiles.map((p) => {
        const normalized = validateWorkspaceContainment(this.workspaceRoot, p);
        validateEditPolicy(normalized, effectivePolicy);
        return normalized;
      });
    }

    const task: TaskState = {
      taskId,
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      prompt: request.prompt,
      status: 'queued',
      version: 1,
      effectiveMode: request.requestedMode,
      effectivePolicy,
      workspaceRoot: this.workspaceRoot,
      targetFiles: validatedTargetFiles,
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

    // 1. Capture pre-planning file snapshots for snapshot binding and concurrent modification detection
    const preSnapshots = new Map<string, { hash: string; mtimeMs: number }>();
    if (task.targetFiles && task.targetFiles.length > 0) {
      for (const p of task.targetFiles) {
        const abs = resolve(task.workspaceRoot, p);
        try {
          if (existsSync(abs)) {
            const st = lstatSync(abs);
            if (!st.isSymbolicLink() && st.isFile()) {
              const buf = readFileSync(abs);
              const h = createHash('sha256').update(buf).digest('hex');
              preSnapshots.set(p, { hash: h, mtimeMs: st.mtimeMs });
            }
          }
        } catch {
          // ignore unreadable
        }
      }
    }
    const planningStartTime = Date.now();

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
          verification: {
            status: 'skipped',
            checks: [],
            summary: 'Verification skipped: read-only task produced no edits',
          },
        });
        return;
      }

      // Restrict release to ONE existing-file update per proposal
      if (proposalOutput.edits.length > 1) {
        throw new TaskExecutionError(
          'Multi-file modifications are not supported in this release: restricted to one existing-file update per proposal',
          400,
          'UNSUPPORTED_OPERATION'
        );
      }

      const rawEdit = proposalOutput.edits[0];

      // Explicitly reject creation and deletion
      if (rawEdit.changeType === 'create') {
        throw new TaskExecutionError(
          'File creation is not supported in this release: restricted to one existing-file update per proposal',
          400,
          'UNSUPPORTED_OPERATION'
        );
      }
      if (rawEdit.changeType === 'delete') {
        throw new TaskExecutionError(
          'File deletion is not supported in this release: restricted to one existing-file update per proposal',
          400,
          'UNSUPPORTED_OPERATION'
        );
      }
      if (rawEdit.changeType !== 'update') {
        throw new TaskExecutionError(
          `Unsupported operation '${rawEdit.changeType}': restricted to one existing-file update per proposal`,
          400,
          'UNSUPPORTED_OPERATION'
        );
      }

      // Enforce workspace containment and reject symlinks using lstat
      const normalizedPath = validateWorkspaceContainment(
        task.workspaceRoot,
        rawEdit.path
      );

      // Enforce verified source scope: if sourceHints were present, candidate must match trusted hint
      if (envelope.sourceHints && envelope.sourceHints.length > 0) {
        const trustedPaths = new Set(
          envelope.sourceHints.map((h) =>
            validateWorkspaceContainment(task.workspaceRoot, h.filePath)
          )
        );
        if (!trustedPaths.has(normalizedPath)) {
          throw new TaskExecutionError(
            `Proposed edit target '${normalizedPath}' is outside the verified source scope (${Array.from(trustedPaths).join(', ')})`,
            403,
            'UNAUTHORIZED_TARGET_FILE'
          );
        }
      }

      // Enforce active permission policy
      validateEditPolicy(normalizedPath, task.effectivePolicy, 'update');

      const absPath = resolve(task.workspaceRoot, normalizedPath);
      if (!existsSync(absPath)) {
        throw new TaskExecutionError(
          `Target file '${normalizedPath}' does not exist on disk: restricted to one existing-file update per proposal`,
          400,
          'FILE_NOT_FOUND'
        );
      }

      const stat = lstatSync(absPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new TaskExecutionError(
          `Target '${normalizedPath}' must be an existing regular file, not a symlink or directory`,
          400,
          'INVALID_TARGET_FILE'
        );
      }

      // Reject modifications made while Codex was generating its proposal
      const diskBuffer = readFileSync(absPath);
      const currentDiskHash = createHash('sha256').update(diskBuffer).digest('hex');

      const preSnap = preSnapshots.get(normalizedPath);
      if (preSnap) {
        if (preSnap.hash !== currentDiskHash) {
          throw new TaskExecutionError(
            `File '${normalizedPath}' was modified concurrently while proposal was being generated (expected hash ${preSnap.hash}, got ${currentDiskHash})`,
            409,
            'CONCURRENT_MODIFICATION'
          );
        }
      } else if (Math.floor(stat.mtimeMs) > planningStartTime) {
        throw new TaskExecutionError(
          `File '${normalizedPath}' was modified concurrently while proposal was being generated`,
          409,
          'CONCURRENT_MODIFICATION'
        );
      }

      // Safe snippet replacement validation: require non-empty oldContent with exactly 1 occurrence
      if (
        !rawEdit.oldContent ||
        typeof rawEdit.oldContent !== 'string' ||
        rawEdit.oldContent.length === 0
      ) {
        throw new TaskExecutionError(
          `Update rejected: missing or empty oldContent snippet for '${normalizedPath}'. Exact snippet matching is required.`,
          400,
          'INVALID_SNIPPET'
        );
      }

      const diskContent = diskBuffer.toString('utf-8');
      const occurrences = countOccurrences(diskContent, rawEdit.oldContent);
      if (occurrences === 0) {
        throw new TaskExecutionError(
          `Target snippet (oldContent) not found in '${normalizedPath}'. Refusing ambiguous edit.`,
          400,
          'SNIPPET_NOT_FOUND'
        );
      }
      if (occurrences > 1) {
        throw new TaskExecutionError(
          `Target snippet (oldContent) is ambiguous (found ${occurrences} occurrences) in '${normalizedPath}'. Refusing ambiguous edit.`,
          400,
          'AMBIGUOUS_SNIPPET'
        );
      }

      const validatedEdits: FileEdit[] = [
        {
          path: normalizedPath,
          changeType: 'update',
          status: 'pending',
          oldContent: rawEdit.oldContent,
          newContent: rawEdit.newContent ?? null,
          description: rawEdit.description,
        },
      ];

      const preconditions: BaseContentPrecondition[] = [
        {
          path: normalizedPath,
          expectedHash: currentDiskHash,
        },
      ];

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
          verification: {
            status: 'skipped',
            checks: [],
            summary: 'Verification skipped: plan mode is read-only',
          },
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
    if (approval.taskId !== taskId) {
      throw new TaskExecutionError(
        `Approval body taskId ('${approval.taskId}') does not match target task ID ('${taskId}')`,
        400,
        'TASK_ID_MISMATCH'
      );
    }

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
      // Release constraint: enforce single file update
      if (task.proposal.edits.length !== 1) {
        throw new TaskExecutionError(
          'Multi-file modifications are not supported in this release: restricted to one existing-file update per proposal',
          400,
          'UNSUPPORTED_OPERATION'
        );
      }

      const edit = task.proposal.edits[0];
      if (edit.changeType !== 'update') {
        throw new TaskExecutionError(
          `Operation '${edit.changeType}' is not supported in this release: restricted to one existing-file update per proposal`,
          400,
          'UNSUPPORTED_OPERATION'
        );
      }

      // Enforce approval scope: explicit approvedPaths: [] must never mean approve everything
      if (approval.approvedPaths !== undefined) {
        if (approval.approvedPaths.length === 0) {
          throw new TaskExecutionError(
            'Explicit approvedPaths is empty: no file modifications were approved',
            400,
            'EMPTY_APPROVED_PATHS'
          );
        }

        const proposedPaths = new Set(task.proposal.edits.map((e) => e.path));
        const approvedPathsSet = new Set<string>();
        for (const p of approval.approvedPaths) {
          const normalized = validateWorkspaceContainment(task.workspaceRoot, p);
          if (!proposedPaths.has(normalized)) {
            throw new TaskExecutionError(
              `Approved path '${p}' is not part of the active proposal`,
              400,
              'UNKNOWN_APPROVED_PATH'
            );
          }
          approvedPathsSet.add(normalized);
        }

        if (!approvedPathsSet.has(edit.path)) {
          throw new TaskExecutionError(
            `Proposed edit for '${edit.path}' was not included in approvedPaths`,
            400,
            'PATH_NOT_APPROVED'
          );
        }
      }

      // Revalidate workspace containment and symlinks at application time using lstat
      const normalizedPath = validateWorkspaceContainment(
        task.workspaceRoot,
        edit.path
      );

      // Revalidate active permission policy and file limit
      validateEditPolicy(normalizedPath, task.effectivePolicy, 'update');

      const absPath = resolve(task.workspaceRoot, normalizedPath);
      if (!existsSync(absPath)) {
        throw new TaskExecutionError(
          `Precondition failed: target file '${normalizedPath}' was removed before changes could be applied`,
          412,
          'PRECONDITION_FAILED'
        );
      }

      const stat = lstatSync(absPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new TaskExecutionError(
          `Target '${normalizedPath}' must be an existing regular file, not a symlink or directory`,
          412,
          'PRECONDITION_FAILED'
        );
      }

      // Check base content precondition
      const currentDiskBuffer = readFileSync(absPath);
      const currentDiskHash = createHash('sha256').update(currentDiskBuffer).digest('hex');
      const expectedHash = task.proposal.preconditions?.find(
        (p) => p.path === normalizedPath
      )?.expectedHash;

      if (expectedHash && currentDiskHash !== expectedHash) {
        throw new TaskExecutionError(
          `Base content precondition failed for '${normalizedPath}': expected hash ${expectedHash}, current disk hash ${currentDiskHash}`,
          412,
          'PRECONDITION_FAILED'
        );
      }

      // Safe snippet replacement: verify snippet occurrence count
      const currentContent = currentDiskBuffer.toString('utf-8');
      if (!edit.oldContent) {
        throw new TaskExecutionError(
          `Update rejected: missing oldContent for '${normalizedPath}'`,
          400,
          'INVALID_SNIPPET'
        );
      }

      const occurrences = countOccurrences(currentContent, edit.oldContent);
      if (occurrences === 0) {
        throw new TaskExecutionError(
          `Precondition failed: target snippet (oldContent) no longer found in '${normalizedPath}'`,
          412,
          'PRECONDITION_FAILED'
        );
      }
      if (occurrences > 1) {
        throw new TaskExecutionError(
          `Precondition failed: target snippet (oldContent) is ambiguous (${occurrences} occurrences) in '${normalizedPath}'`,
          412,
          'AMBIGUOUS_SNIPPET'
        );
      }

      const idx = currentContent.indexOf(edit.oldContent);
      const nextContent =
        currentContent.slice(0, idx) +
        (edit.newContent ?? '') +
        currentContent.slice(idx + edit.oldContent.length);

      // Apply update using atomic staged replacement procedure
      this.stageAndReplaceFile(absPath, nextContent);
      edit.status = 'applied';
      edit.appliedAt = createTimestamp();

      // 3. Verification Phase
      let verificationOutcome: VerificationOutcome;
      if (this.verificationCommand) {
        verificationOutcome = await this.runVerificationCommand(
          this.verificationCommand,
          task.workspaceRoot,
          this.verificationTimeoutMs
        );
      } else {
        // Built-in verification: verify syntax AST integrity
        verificationOutcome = this.verifyFileSyntax(normalizedPath, nextContent);
      }

      task.verification = verificationOutcome;

      if (verificationOutcome.status === 'passed') {
        this.completeTask(task, {
          type: 'edits_applied',
          summary: 'Successfully applied 1 file modification and passed verification',
          appliedEditsCount: 1,
          verification: verificationOutcome,
        });
      } else if (verificationOutcome.status === 'skipped') {
        this.completeTask(task, {
          type: 'edits_applied',
          summary: 'Successfully applied 1 file modification (verification skipped)',
          appliedEditsCount: 1,
          verification: verificationOutcome,
        });
      } else {
        this.failTask(
          task,
          'APPLY_FAILED',
          `Verification checks failed after applying edits: ${verificationOutcome.checks[0]?.message ?? 'Checks failed'}`,
          'execution'
        );
        throw new TaskExecutionError(
          `Verification checks failed after applying edits: ${verificationOutcome.checks[0]?.message ?? 'Checks failed'}`,
          400,
          'VERIFICATION_FAILED'
        );
      }
    } catch (err) {
      const message = (err as Error).message;
      const category: ErrorCategory =
        err instanceof TaskExecutionError &&
        (err.code === 'PRECONDITION_FAILED' || err.code === 'AMBIGUOUS_SNIPPET')
          ? 'preflight'
          : 'execution';
      this.failTask(task, 'APPLY_FAILED', message, category);
      throw err;
    }

    return task;
  }

  /**
   * Applies single-file replacement using a safe staged write procedure.
   * Ensures staging file is created in the same filesystem directory and atomically renamed.
   */
  private stageAndReplaceFile(absPath: string, nextContent: string): void {
    const dir = dirname(absPath);
    const stagingPath = resolve(
      dir,
      `.summon-stage-${Date.now()}-${randomBytes(6).toString('hex')}.tmp`
    );

    try {
      writeFileSync(stagingPath, nextContent, { encoding: 'utf-8', mode: 0o644 });
      renameSync(stagingPath, absPath);
    } catch (err) {
      try {
        if (existsSync(stagingPath)) {
          unlinkSync(stagingPath);
        }
      } catch {
        // ignore unlink error
      }
      throw new TaskExecutionError(
        `Failed to safely write update to '${absPath}': ${(err as Error).message}`,
        500,
        'WRITE_FAILED'
      );
    }
  }

  /**
   * Performs actual syntax AST verification for TypeScript, JavaScript, and JSON files.
   * Explicitly returns 'skipped' for non-analyzable formats when no external verification command is configured.
   */
  private verifyFileSyntax(filePath: string, content: string): VerificationOutcome {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const startTime = Date.now();

    if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') {
      const isJsx = ext === 'tsx' || ext === 'jsx';
      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );
      const diagnostics = (sourceFile as any).parseDiagnostics;
      const durationMs = Date.now() - startTime;
      if (diagnostics && diagnostics.length > 0) {
        const msg = diagnostics
          .map((d: any) =>
            typeof d.messageText === 'string'
              ? d.messageText
              : d.messageText?.messageText ?? 'Syntax error'
          )
          .join('; ');
        return {
          status: 'failed',
          checks: [
            {
              name: 'syntax-verification',
              status: 'failed',
              message: `Syntax error in ${filePath}: ${msg}`,
              durationMs,
            },
          ],
          summary: `Syntax verification failed for ${filePath}`,
        };
      }

      return {
        status: 'passed',
        checks: [
          {
            name: 'syntax-verification',
            status: 'passed',
            message: `Verified syntax AST integrity for ${filePath}`,
            durationMs,
          },
        ],
        summary: `Verified syntax for ${filePath}`,
      };
    }

    if (ext === 'json') {
      const durationMs = Date.now() - startTime;
      try {
        JSON.parse(content);
        return {
          status: 'passed',
          checks: [
            {
              name: 'json-syntax-verification',
              status: 'passed',
              message: `Verified JSON syntax for ${filePath}`,
              durationMs,
            },
          ],
          summary: `Verified JSON syntax for ${filePath}`,
        };
      } catch (err) {
        return {
          status: 'failed',
          checks: [
            {
              name: 'json-syntax-verification',
              status: 'failed',
              message: `Invalid JSON in ${filePath}: ${(err as Error).message}`,
              durationMs,
            },
          ],
          summary: `JSON syntax verification failed for ${filePath}`,
        };
      }
    }

    return {
      status: 'skipped',
      checks: [],
      summary: `Verification skipped: no verification command configured for '${ext}' files`,
    };
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
