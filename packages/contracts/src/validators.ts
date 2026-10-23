import { z } from 'zod';
import {
  TaskRequestSchema,
  TaskRequest,
  TaskStateSchema,
  TaskState,
  TaskStatus,
} from './tasks.js';
import {
  FileEditSchema,
  FileEdit,
  MultiFileEditPlanSchema,
  MultiFileEditPlan,
  EditApprovalResponse,
} from './edits.js';
import {
  PermissionPolicySchema,
  PermissionPolicy,
} from './permissions.js';
import {
  TaskEventSchema,
  TaskEvent,
} from './events.js';

export type SafeValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: z.ZodError };

/**
 * Validates and parses raw input into an untrusted TaskRequest. Throws ZodError on failure.
 */
export function validateTaskRequest(input: unknown): TaskRequest {
  return TaskRequestSchema.parse(input);
}

/**
 * Safely validates raw input into an untrusted TaskRequest without throwing.
 */
export function safeValidateTaskRequest(input: unknown): SafeValidationResult<TaskRequest> {
  const result = TaskRequestSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Validates and parses raw input into an authoritative TaskState. Throws ZodError on failure.
 */
export function validateTaskState(input: unknown): TaskState {
  return TaskStateSchema.parse(input);
}

/**
 * Safely validates raw input into an authoritative TaskState without throwing.
 */
export function safeValidateTaskState(input: unknown): SafeValidationResult<TaskState> {
  const result = TaskStateSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Validates and parses raw input into a TaskEvent. Throws ZodError on failure.
 */
export function validateTaskEvent(input: unknown): TaskEvent {
  return TaskEventSchema.parse(input);
}

/**
 * Safely validates raw input into a TaskEvent without throwing.
 */
export function safeValidateTaskEvent(input: unknown): SafeValidationResult<TaskEvent> {
  const result = TaskEventSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Validates and parses a single FileEdit. Throws ZodError on failure.
 */
export function validateFileEdit(input: unknown): FileEdit {
  return FileEditSchema.parse(input);
}

/**
 * Safely validates a single FileEdit without throwing.
 */
export function safeValidateFileEdit(input: unknown): SafeValidationResult<FileEdit> {
  const result = FileEditSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Validates and parses a MultiFileEditPlan. Throws ZodError on failure.
 */
export function validateMultiFileEditPlan(input: unknown): MultiFileEditPlan {
  return MultiFileEditPlanSchema.parse(input);
}

/**
 * Safely validates a MultiFileEditPlan without throwing.
 */
export function safeValidateMultiFileEditPlan(input: unknown): SafeValidationResult<MultiFileEditPlan> {
  const result = MultiFileEditPlanSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Validates and parses a PermissionPolicy. Throws ZodError on failure.
 */
export function validatePermissionPolicy(input: unknown): PermissionPolicy {
  return PermissionPolicySchema.parse(input);
}

/**
 * Safely validates a PermissionPolicy without throwing.
 */
export function safeValidatePermissionPolicy(input: unknown): SafeValidationResult<PermissionPolicy> {
  const result = PermissionPolicySchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Validates an approval response against an active proposal, rejecting stale versions
 * or mismatched digests.
 */
export function validateApprovalAgainstProposal(
  approval: EditApprovalResponse,
  activeProposal: { proposalDigest?: string; taskVersion: number }
): { valid: true } | { valid: false; reason: 'stale_version' | 'digest_mismatch'; message: string } {
  if (approval.taskVersion !== activeProposal.taskVersion) {
    return {
      valid: false,
      reason: 'stale_version',
      message: `Approval rejected: task version ${approval.taskVersion} does not match current task version ${activeProposal.taskVersion}`,
    };
  }

  if (activeProposal.proposalDigest && approval.proposalDigest !== activeProposal.proposalDigest) {
    return {
      valid: false,
      reason: 'digest_mismatch',
      message: `Approval rejected: proposal digest ${approval.proposalDigest} does not match active proposal digest ${activeProposal.proposalDigest}`,
    };
  }

  return { valid: true };
}

/**
 * Terminal task statuses representing finished workflows.
 */
export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/**
 * Returns true if the provided status is terminal (task finished).
 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

/**
 * Valid state transitions for a task.
 * Explicitly supports:
 * - preflight failure from queued or planning -> failed
 * - read-only completion from planning -> completed (e.g. plan-only mode)
 */
const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set(['planning', 'failed', 'cancelled']),
  planning: new Set(['awaiting_approval', 'executing', 'completed', 'failed', 'cancelled']),
  awaiting_approval: new Set(['planning', 'executing', 'failed', 'cancelled']),
  executing: new Set(['completed', 'failed', 'cancelled']),
  completed: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
};

/**
 * Checks whether transitioning from `current` to `next` status is legally valid.
 */
export function canTransitionTaskStatus(current: TaskStatus, next: TaskStatus): boolean {
  if (current === next) {
    return true;
  }
  return VALID_TRANSITIONS[current]?.has(next) ?? false;
}

/**
 * Validates whether a real-time event is acceptable given the task's current lifecycle status.
 */
export function validateEventForStatus(
  currentStatus: TaskStatus,
  event: TaskEvent
): { valid: true } | { valid: false; reason: string } {
  if (isTerminalTaskStatus(currentStatus)) {
    return {
      valid: false,
      reason: `Cannot process event '${event.type}' on a task already in terminal status '${currentStatus}'`,
    };
  }

  switch (event.type) {
    case 'task:created':
      return {
        valid: false,
        reason: "Cannot receive 'task:created' on an already existing task",
      };

    case 'task:status_changed':
      if (!canTransitionTaskStatus(currentStatus, event.status)) {
        return {
          valid: false,
          reason: `Illegal status transition from '${currentStatus}' to '${event.status}' in status_changed event`,
        };
      }
      return { valid: true };

    case 'task:progress':
      return { valid: true };

    case 'task:plan_proposed':
    case 'task:approval_requested':
      if (currentStatus !== 'planning') {
        return {
          valid: false,
          reason: `Cannot propose plan or request approval when status is '${currentStatus}' (must be 'planning')`,
        };
      }
      return { valid: true };

    case 'task:approval_responded':
      if (currentStatus !== 'awaiting_approval') {
        return {
          valid: false,
          reason: `Cannot process approval response when status is '${currentStatus}' (must be 'awaiting_approval')`,
        };
      }
      return { valid: true };

    case 'task:edits_applied':
    case 'task:verification_completed':
      if (currentStatus !== 'executing') {
        return {
          valid: false,
          reason: `Cannot apply edits or record verification when status is '${currentStatus}' (must be 'executing')`,
        };
      }
      return { valid: true };

    case 'task:completed':
      if (currentStatus !== 'planning' && currentStatus !== 'executing') {
        return {
          valid: false,
          reason: `Cannot complete task from status '${currentStatus}' (must be 'planning' for read-only or 'executing')`,
        };
      }
      return { valid: true };

    case 'task:failed':
    case 'task:cancelled':
      return { valid: true };

    default:
      return { valid: true };
  }
}

/**
 * Generates an engine-owned unique task ID with optional prefix.
 */
export function createTaskId(prefix: string = 'task'): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 9);
  return `${prefix}_${timestamp}_${randomPart}`;
}

/**
 * Generates a client-side request tracking ID.
 */
export function createRequestId(prefix: string = 'req'): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 9);
  return `${prefix}_${timestamp}_${randomPart}`;
}

/**
 * Returns current timestamp formatted as ISO 8601 string.
 */
export function createTimestamp(): string {
  return new Date().toISOString();
}
