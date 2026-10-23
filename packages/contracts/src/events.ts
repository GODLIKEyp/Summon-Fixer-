import { z } from 'zod';
import {
  TaskStatusSchema,
  TaskRequestSchema,
  TaskProgressSchema,
  TaskErrorSchema,
  CompletionOutcomeSchema,
  VerificationOutcomeSchema,
} from './tasks.js';
import { MultiFileEditPlanSchema, FileEditSchema, EditApprovalResponseSchema } from './edits.js';

export const TaskCreatedEventSchema = z.object({
  type: z.literal('task:created'),
  taskId: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
  timestamp: z.string().datetime(),
  request: TaskRequestSchema,
});
export type TaskCreatedEvent = z.infer<typeof TaskCreatedEventSchema>;

export const TaskStatusChangedEventSchema = z.object({
  type: z.literal('task:status_changed'),
  taskId: z.string().min(1).max(128),
  timestamp: z.string().datetime(),
  previousStatus: TaskStatusSchema,
  status: TaskStatusSchema,
  version: z.number().int().positive().optional(),
  reason: z.string().max(1000).optional(),
});
export type TaskStatusChangedEvent = z.infer<typeof TaskStatusChangedEventSchema>;

export const TaskProgressEventSchema = z.object({
  type: z.literal('task:progress'),
  taskId: z.string().min(1).max(128),
  timestamp: z.string().datetime(),
  progress: TaskProgressSchema,
});
export type TaskProgressEvent = z.infer<typeof TaskProgressEventSchema>;

export const TaskPlanProposedEventSchema = z.object({
  type: z.literal('task:plan_proposed'),
  taskId: z.string().min(1).max(128),
  taskVersion: z.number().int().positive(),
  timestamp: z.string().datetime(),
  proposal: MultiFileEditPlanSchema,
});
export type TaskPlanProposedEvent = z.infer<typeof TaskPlanProposedEventSchema>;

export const TaskApprovalRequestedEventSchema = z.object({
  type: z.literal('task:approval_requested'),
  taskId: z.string().min(1).max(128),
  taskVersion: z.number().int().positive(),
  proposalDigest: z.string().min(1).max(128),
  timestamp: z.string().datetime(),
  proposal: MultiFileEditPlanSchema,
  timeoutMs: z.number().int().positive().optional(),
});
export type TaskApprovalRequestedEvent = z.infer<typeof TaskApprovalRequestedEventSchema>;

export const TaskApprovalRespondedEventSchema = z.object({
  type: z.literal('task:approval_responded'),
  taskId: z.string().min(1).max(128),
  taskVersion: z.number().int().positive(),
  proposalDigest: z.string().min(1).max(128),
  timestamp: z.string().datetime(),
  response: EditApprovalResponseSchema,
});
export type TaskApprovalRespondedEvent = z.infer<typeof TaskApprovalRespondedEventSchema>;

export const TaskEditsAppliedEventSchema = z.object({
  type: z.literal('task:edits_applied'),
  taskId: z.string().min(1).max(128),
  timestamp: z.string().datetime(),
  edits: z.array(FileEditSchema),
});
export type TaskEditsAppliedEvent = z.infer<typeof TaskEditsAppliedEventSchema>;

export const TaskVerificationCompletedEventSchema = z.object({
  type: z.literal('task:verification_completed'),
  taskId: z.string().min(1).max(128),
  timestamp: z.string().datetime(),
  verification: VerificationOutcomeSchema,
});
export type TaskVerificationCompletedEvent = z.infer<typeof TaskVerificationCompletedEventSchema>;

export const TaskCompletedEventSchema = z.object({
  type: z.literal('task:completed'),
  taskId: z.string().min(1).max(128),
  timestamp: z.string().datetime(),
  outcome: CompletionOutcomeSchema,
  edits: z.array(FileEditSchema).default([]),
});
export type TaskCompletedEvent = z.infer<typeof TaskCompletedEventSchema>;

export const TaskFailedEventSchema = z.object({
  type: z.literal('task:failed'),
  taskId: z.string().min(1).max(128),
  timestamp: z.string().datetime(),
  error: TaskErrorSchema,
});
export type TaskFailedEvent = z.infer<typeof TaskFailedEventSchema>;

export const TaskCancelledEventSchema = z.object({
  type: z.literal('task:cancelled'),
  taskId: z.string().min(1).max(128),
  timestamp: z.string().datetime(),
  reason: z.string().max(1000).optional(),
});
export type TaskCancelledEvent = z.infer<typeof TaskCancelledEventSchema>;

/**
 * Real-time event union for IPC, WebSocket, and SSE communication.
 */
export const TaskEventSchema = z.discriminatedUnion('type', [
  TaskCreatedEventSchema,
  TaskStatusChangedEventSchema,
  TaskProgressEventSchema,
  TaskPlanProposedEventSchema,
  TaskApprovalRequestedEventSchema,
  TaskApprovalRespondedEventSchema,
  TaskEditsAppliedEventSchema,
  TaskVerificationCompletedEventSchema,
  TaskCompletedEventSchema,
  TaskFailedEventSchema,
  TaskCancelledEventSchema,
]);
export type TaskEvent = z.infer<typeof TaskEventSchema>;
