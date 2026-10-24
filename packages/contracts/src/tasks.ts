import { z } from 'zod';
import { PermissionModeSchema, PermissionPolicySchema } from './permissions.js';
import { FileEditSchema, MultiFileEditPlanSchema } from './edits.js';
import { TaskContextSchema } from './context.js';

/**
 * Lifecycle states of a Summon Fixer task.
 *
 * - `queued`: Task submitted and waiting for runner pickup.
 * - `planning`: Runner is analyzing the workspace and constructing a multi-file plan.
 * - `awaiting_approval`: Plan or diffs proposed; waiting for human approval (manual/plan mode).
 * - `executing`: Runner is applying approved changes or performing verification.
 * - `completed`: Task successfully finished (either edits applied or read-only completion).
 * - `failed`: Preflight check, policy check, or execution error encountered.
 * - `cancelled`: Task was aborted by the user.
 */
export const TaskStatusSchema = z.enum([
  'queued',
  'planning',
  'awaiting_approval',
  'executing',
  'completed',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * Task priority level.
 */
export const TaskPrioritySchema = z.enum(['low', 'normal', 'high']).default('normal');
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

/**
 * Untrusted task request submitted from a client (Vite overlay, CLI, or IDE).
 * Note: The browser cannot set `taskId`, cannot provide `permissionPolicy`,
 * and cannot specify `workspaceRoot`.
 */
export const TaskRequestSchema = z.object({
  /**
   * Client-assigned request tracking ID (UUID or nanoid).
   * Distinct from the server-assigned authoritative taskId.
   */
  requestId: z.string().min(1, 'requestId cannot be empty').max(128, 'requestId exceeds 128 characters'),

  /**
   * Optional client idempotency key to prevent duplicate task execution.
   */
  idempotencyKey: z.string().min(1).max(128).optional(),

  /**
   * Natural language user prompt describing the requested fix, feature, or question.
   * Strictly rejects empty or whitespace-only inputs, bounded to 10,000 characters.
   */
  prompt: z
    .string()
    .trim()
    .min(1, 'Prompt cannot be empty or whitespace only')
    .max(10_000, 'Prompt exceeds maximum length of 10,000 characters'),

  /**
   * Requested permission mode. The engine determines the final effective policy.
   */
  requestedMode: PermissionModeSchema.default('plan'),

  /**
   * Surrounding context gathered from UI inspector or editor.
   */
  context: TaskContextSchema.optional(),

  /**
   * Explicit target file paths or globs for multi-file edits.
   */
  targetFiles: z.array(z.string().min(1).max(500)).max(100).optional(),

  /**
   * Task priority.
   */
  priority: TaskPrioritySchema.default('normal'),

  /**
   * ISO 8601 timestamp when the request was initiated.
   */
  createdAt: z.string().datetime(),

  /**
   * Arbitrary client-defined metadata.
   */
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type TaskRequest = z.infer<typeof TaskRequestSchema>;

/**
 * Execution progress reporting for a running task.
 */
export const TaskProgressSchema = z.object({
  /**
   * Current 1-based step number.
   */
  step: z.number().int().nonnegative(),

  /**
   * Total estimated steps, if known.
   */
  totalSteps: z.number().int().positive().optional(),

  /**
   * Current execution phase (e.g., 'preflight', 'analyzing', 'planning', 'applying_edits', 'verifying').
   */
  phase: z.string().min(1).max(100),

  /**
   * User-visible status message describing current activity.
   */
  message: z.string().min(1).max(1000),

  /**
   * Estimated completion percentage (0 - 100).
   */
  percentage: z.number().min(0).max(100).optional(),
});
export type TaskProgress = z.infer<typeof TaskProgressSchema>;

/**
 * Classification category of errors.
 */
export const ErrorCategorySchema = z.enum([
  'preflight',
  'policy',
  'execution',
  'timeout',
  'internal',
]);
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

/**
 * Detailed error payload when a task fails.
 * Explicitly supports preflight failure categorization.
 */
export const TaskErrorSchema = z.object({
  /**
   * Category of failure.
   */
  category: ErrorCategorySchema.default('execution'),

  /**
   * Error classification code (e.g. ERR_PREFLIGHT_DIRTY_TREE, ERR_POLICY_VIOLATION).
   */
  code: z.string().min(1).max(128),

  /**
   * Human-readable error message.
   */
  message: z.string().min(1).max(2000),

  /**
   * Structured diagnostic details or stack trace.
   */
  details: z.unknown().optional(),

  /**
   * Whether the error is recoverable via user retry or parameter correction.
   */
  recoverable: z.boolean().default(false),
});
export type TaskError = z.infer<typeof TaskErrorSchema>;

/**
 * Verification outcome status.
 */
export const VerificationStatusSchema = z.enum(['passed', 'failed', 'skipped']);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

/**
 * Individual check result within a verification run.
 */
export const VerificationCheckSchema = z.object({
  name: z.string().min(1).max(256),
  status: VerificationStatusSchema,
  message: z.string().max(1000).optional(),
  output: z.string().max(50_000).optional(),
  durationMs: z.number().nonnegative().optional(),
});
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

/**
 * Typed verification outcome (linter, typecheck, test runner).
 */
export const VerificationOutcomeSchema = z.object({
  status: VerificationStatusSchema,
  checks: z.array(VerificationCheckSchema).max(100).default([]),
  summary: z.string().max(2000).optional(),
});
export type VerificationOutcome = z.infer<typeof VerificationOutcomeSchema>;

/**
 * Typed completion outcome distinguishing read-only completion from applied edits.
 */
export const CompletionOutcomeSchema = z.object({
  /**
   * Completion type:
   * - `edits_applied`: Files were modified on disk.
   * - `read_only`: Plan/analysis completed with no disk modifications (e.g. 'plan' mode).
   * - `no_op`: Task completed finding that no edits were necessary.
   */
  type: z.enum(['edits_applied', 'read_only', 'no_op']),

  /**
   * High-level summary of the outcome.
   */
  summary: z.string().min(1).max(2000),

  /**
   * Count of files written to disk.
   */
  appliedEditsCount: z.number().int().nonnegative().default(0),

  /**
   * Verification outcome, if run.
   */
  verification: VerificationOutcomeSchema.optional(),
});
export type CompletionOutcome = z.infer<typeof CompletionOutcomeSchema>;

/**
 * Structured log entry recorded during task execution.
 */
export const TaskLogEntrySchema = z.object({
  timestamp: z.string().datetime(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string().max(2000),
});
export type TaskLogEntry = z.infer<typeof TaskLogEntrySchema>;

/**
 * Authoritative server-side state snapshot of a task.
 * Owned by the engine.
 */
export const TaskStateSchema = z.object({
  /**
   * Authoritative server-assigned task ID.
   */
  taskId: z.string().min(1).max(128),

  /**
   * Original client requestId.
   */
  requestId: z.string().min(1).max(128),

  /**
   * Client-supplied idempotency key, if provided.
   */
  idempotencyKey: z.string().min(1).max(128).optional(),

  /**
   * Monotonically increasing version counter for concurrency and stale approval checks.
   */
  version: z.number().int().positive().default(1),

  /**
   * Engine-resolved workspace root directory. Strictly engine-owned.
   */
  workspaceRoot: z.string().min(1),

  /**
   * Engine-computed effective permission policy.
   */
  effectivePolicy: PermissionPolicySchema,

  /**
   * Effective permission mode.
   */
  effectiveMode: PermissionModeSchema,

  /**
   * Sanitized prompt.
   */
  prompt: z.string().min(1).max(10_000),

  /**
   * Current lifecycle state.
   */
  status: TaskStatusSchema,

  /**
   * Context supplied with the request.
   */
  context: TaskContextSchema.optional(),

  /**
   * Targeted file paths for multi-file edits.
   */
  targetFiles: z.array(z.string().min(1).max(500)).max(100).optional(),

  /**
   * Real-time progress details.
   */
  progress: TaskProgressSchema.optional(),

  /**
   * Authoritative multi-file proposal with digest and preconditions.
   */
  proposal: MultiFileEditPlanSchema.optional(),

  /**
   * Array of individual file modifications.
   */
  edits: z.array(FileEditSchema).max(100).default([]),

  /**
   * Typed verification outcome.
   */
  verification: VerificationOutcomeSchema.optional(),

  /**
   * Typed completion outcome (supports read-only completion).
   */
  completion: CompletionOutcomeSchema.optional(),

  /**
   * Error details if the task failed (supports preflight failure).
   */
  error: TaskErrorSchema.optional(),

  /**
   * Execution log trail.
   */
  logs: z.array(TaskLogEntrySchema).max(1000).default([]),

  /**
   * ISO 8601 creation timestamp.
   */
  createdAt: z.string().datetime(),

  /**
   * ISO 8601 last update timestamp.
   */
  updatedAt: z.string().datetime(),

  /**
   * ISO 8601 completion timestamp, if resolved.
   */
  completedAt: z.string().datetime().optional(),
});
export type TaskState = z.infer<typeof TaskStateSchema>;

/**
 * Idempotency record schema for tracking task creation deduplication.
 */
export const IdempotencyRecordSchema = z.object({
  idempotencyKey: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128),
  createdAt: z.string().datetime(),
});
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;
