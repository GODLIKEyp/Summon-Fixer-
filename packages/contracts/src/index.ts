/**
 * @summon-fixer/contracts
 * Shared contract schemas, TypeScript types, and validation helpers for Summon Fixer.
 */

// Permissions
export {
  PermissionModeSchema,
  type PermissionMode,
  PermissionPolicySchema,
  type PermissionPolicy,
  DEFAULT_DISALLOWED_PATHS,
  DEFAULT_ALLOWED_PATHS,
  DEFAULT_PERMISSION_POLICIES,
  getDefaultPermissionPolicy,
  isPathAllowedByPolicy,
} from './permissions.js';

// Multi-file edits & proposals
export {
  normalizeWorkspacePath,
  FileChangeTypeSchema,
  type FileChangeType,
  FileEditStatusSchema,
  type FileEditStatus,
  FileEditSchema,
  type FileEdit,
  type DigestableEdit,
  BaseContentPreconditionSchema,
  type BaseContentPrecondition,
  computeProposalDigest,
  MultiFileEditPlanSchema,
  type MultiFileEditPlan,
  createProposal,
  EditApprovalDecisionSchema,
  type EditApprovalDecision,
  EditApprovalResponseSchema,
  type EditApprovalResponse,
} from './edits.js';

// Context
export {
  LineRangeSchema,
  type LineRange,
  FileContextSchema,
  type FileContext,
  SourceSelectionSchema,
  type SourceSelection,
  UIContextSchema,
  type UIContext,
  ClientContextSchema,
  type ClientContext,
  TaskContextSchema,
  type TaskContext,
} from './context.js';

// Tasks & Lifecycle
export {
  TaskStatusSchema,
  type TaskStatus,
  TaskPrioritySchema,
  type TaskPriority,
  TaskRequestSchema,
  type TaskRequest,
  TaskProgressSchema,
  type TaskProgress,
  ErrorCategorySchema,
  type ErrorCategory,
  TaskErrorSchema,
  type TaskError,
  VerificationStatusSchema,
  type VerificationStatus,
  VerificationCheckSchema,
  type VerificationCheck,
  VerificationOutcomeSchema,
  type VerificationOutcome,
  CompletionOutcomeSchema,
  type CompletionOutcome,
  TaskLogEntrySchema,
  type TaskLogEntry,
  TaskStateSchema,
  type TaskState,
  IdempotencyRecordSchema,
  type IdempotencyRecord,
} from './tasks.js';

// Real-time Events
export {
  TaskCreatedEventSchema,
  type TaskCreatedEvent,
  TaskStatusChangedEventSchema,
  type TaskStatusChangedEvent,
  TaskProgressEventSchema,
  type TaskProgressEvent,
  TaskPlanProposedEventSchema,
  type TaskPlanProposedEvent,
  TaskApprovalRequestedEventSchema,
  type TaskApprovalRequestedEvent,
  TaskApprovalRespondedEventSchema,
  type TaskApprovalRespondedEvent,
  TaskEditsAppliedEventSchema,
  type TaskEditsAppliedEvent,
  TaskVerificationCompletedEventSchema,
  type TaskVerificationCompletedEvent,
  TaskCompletedEventSchema,
  type TaskCompletedEvent,
  TaskFailedEventSchema,
  type TaskFailedEvent,
  TaskCancelledEventSchema,
  type TaskCancelledEvent,
  TaskEventSchema,
  type TaskEvent,
} from './events.js';

// Validators & Utilities
export {
  type SafeValidationResult,
  validateTaskRequest,
  safeValidateTaskRequest,
  validateTaskState,
  safeValidateTaskState,
  validateTaskEvent,
  safeValidateTaskEvent,
  validateFileEdit,
  safeValidateFileEdit,
  validateMultiFileEditPlan,
  safeValidateMultiFileEditPlan,
  validatePermissionPolicy,
  safeValidatePermissionPolicy,
  validateApprovalAgainstProposal,
  TERMINAL_TASK_STATUSES,
  isTerminalTaskStatus,
  canTransitionTaskStatus,
  validateEventForStatus,
  createTaskId,
  createRequestId,
  createTimestamp,
} from './validators.js';
