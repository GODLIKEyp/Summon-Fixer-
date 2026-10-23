import { z } from 'zod';
import {
  TaskRequestSchema,
  type TaskRequest,
  EditApprovalResponseSchema,
  type EditApprovalResponse,
} from '@summon-fixer/contracts';

/**
 * Server-resolved source hint providing contextual location
 * information about the selected UI element.
 */
export const SourceHintSchema = z.object({
  filePath: z.string().min(1).max(1000),
  lineRange: z
    .object({
      start: z.number().int().min(1),
      end: z.number().int().min(1),
    })
    .optional(),
  componentName: z.string().max(256).optional(),
  elementTag: z.string().max(64).optional(),
  textContent: z.string().max(2000).optional(),
  framework: z.string().max(64).optional(),
});

export type SourceHint = z.infer<typeof SourceHintSchema>;

/**
 * Authenticated internal envelope forwarded by the Vite server proxy.
 * Encapsulates the untrusted browser TaskRequest alongside server-resolved source hints.
 */
export const TaskEnvelopeSchema = z.object({
  request: TaskRequestSchema,
  sourceHints: z.array(SourceHintSchema).max(20).optional(),
});

export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;

/**
 * Internal envelope for applying task approvals.
 */
export const ApplyEnvelopeSchema = z.object({
  approval: EditApprovalResponseSchema,
});

export type ApplyEnvelope = z.infer<typeof ApplyEnvelopeSchema>;
