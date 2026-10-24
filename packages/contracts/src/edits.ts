import { z } from 'zod';
import { sha256 } from './sha256.js';

/**
 * Normalizes a workspace-relative file path.
 * Strips leading './', replaces backslashes with forward slashes, collapses redundant slashes,
 * and rejects directory traversal ('..') or absolute paths.
 */
export function normalizeWorkspacePath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new Error('Path must be a non-empty string');
  }

  // Replace backslashes
  let normalized = rawPath.replace(/\\/g, '/');

  // Disallow absolute paths
  if (normalized.startsWith('/')) {
    throw new Error(`Absolute paths are not allowed: ${rawPath}`);
  }

  // Split and validate segments
  const segments = normalized.split('/');
  const cleaned: string[] = [];

  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      throw new Error(`Path traversal with '..' is strictly forbidden: ${rawPath}`);
    }
    cleaned.push(segment);
  }

  if (cleaned.length === 0) {
    throw new Error(`Normalized path cannot be empty: ${rawPath}`);
  }

  return cleaned.join('/');
}

/**
 * Type of file change operation proposed or executed.
 */
export const FileChangeTypeSchema = z.enum(['create', 'update', 'delete']);
export type FileChangeType = z.infer<typeof FileChangeTypeSchema>;

/**
 * Lifecycle status of an individual file edit within a multi-file task.
 */
export const FileEditStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'applied',
  'failed',
]);
export type FileEditStatus = z.infer<typeof FileEditStatusSchema>;

/**
 * Representation of an individual file modification proposal or result.
 * Strictly rejects contradictory edit payloads and enforces normalized paths.
 */
export const FileEditSchema = z
  .object({
    /**
     * Workspace-relative path to the file being modified.
     */
    path: z
      .string()
      .min(1, 'File path cannot be empty')
      .max(500, 'File path exceeds maximum length of 500 characters'),

    /**
     * Type of filesystem change: create, update, or delete.
     */
    changeType: FileChangeTypeSchema,

    /**
     * Human-readable explanation of why this specific file change was made.
     */
    description: z.string().max(1000).optional(),

    /**
     * Original file content before modification.
     * Must be null or undefined for 'create'.
     */
    oldContent: z.string().nullable().optional(),

    /**
     * New file content after modification.
     * Must be null or undefined for 'delete', and non-null string for 'create'.
     */
    newContent: z.string().nullable().optional(),

    /**
     * Unified diff representation of the proposed change.
     */
    patch: z.string().max(500_000).optional(),

    /**
     * Approval and application status for this specific file edit.
     */
    status: FileEditStatusSchema.default('pending'),

    /**
     * ISO 8601 timestamp when this edit was applied to disk, if applicable.
     */
    appliedAt: z.string().datetime().optional(),

    /**
     * Error message if applying this edit failed.
     */
    error: z.string().max(1000).optional(),
  })
  .superRefine((data, ctx) => {
    // Validate path normalization
    try {
      normalizeWorkspacePath(data.path);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['path'],
        message: err instanceof Error ? err.message : 'Invalid workspace path',
      });
    }

    // Contradictory edits check: create
    if (data.changeType === 'create') {
      if (data.oldContent !== undefined && data.oldContent !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['oldContent'],
          message: "Contradictory edit: 'create' operation cannot have non-null oldContent",
        });
      }
      if (data.newContent === undefined || data.newContent === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['newContent'],
          message: "Contradictory edit: 'create' operation requires non-null newContent",
        });
      }
    }

    // Contradictory edits check: delete
    if (data.changeType === 'delete') {
      if (data.newContent !== undefined && data.newContent !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['newContent'],
          message: "Contradictory edit: 'delete' operation cannot have non-null newContent",
        });
      }
    }

    // Contradictory edits check: update
    if (data.changeType === 'update') {
      if ((data.newContent === undefined || data.newContent === null) && !data.patch) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['newContent'],
          message: "Contradictory edit: 'update' operation must provide at least newContent or patch",
        });
      }
      if (
        data.oldContent !== undefined &&
        data.oldContent !== null &&
        data.newContent !== undefined &&
        data.newContent !== null &&
        data.oldContent === data.newContent
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['newContent'],
          message: "Contradictory edit: 'update' operation has identical oldContent and newContent (no-op)",
        });
      }
    }
  });

export type FileEdit = z.infer<typeof FileEditSchema>;

/**
 * Precondition specifying the expected base content hash for a file before an edit can be applied.
 */
export const BaseContentPreconditionSchema = z.object({
  path: z.string().min(1).max(500),
  expectedHash: z.string().min(1).max(128),
  expectedRevision: z.string().max(128).optional(),
});
export type BaseContentPrecondition = z.infer<typeof BaseContentPreconditionSchema>;

/**
 * Minimal edit specification required for computing deterministic proposal digests.
 */
export type DigestableEdit = {
  path: string;
  changeType: FileChangeType;
  oldContent?: string | null;
  newContent?: string | null;
  patch?: string | null;
};

/**
 * Computes a deterministic SHA-256 digest of a set of file edits and task version.
 */
export function computeProposalDigest(
  edits: readonly DigestableEdit[],
  taskVersion: number
): string {
  // Sort edits by normalized path to guarantee deterministic digest
  const sorted = [...edits].sort((a, b) => {
    const pathA = normalizeWorkspacePath(a.path);
    const pathB = normalizeWorkspacePath(b.path);
    return pathA.localeCompare(pathB);
  });

  const canonicalPayload = {
    version: taskVersion,
    edits: sorted.map((e) => ({
      path: normalizeWorkspacePath(e.path),
      changeType: e.changeType,
      oldContent: e.oldContent ?? null,
      newContent: e.newContent ?? null,
      patch: e.patch ?? null,
    })),
  };

  return sha256(JSON.stringify(canonicalPayload));
}

/**
 * Authoritative multi-file edit proposal generated by Codex.
 * Rejects duplicate normalized paths and inconsistent file counts.
 */
export const MultiFileEditPlanSchema = z
  .object({
    /**
     * Unique identifier for this proposal.
     */
    proposalId: z.string().min(1).max(128).default(() => `prop_${Date.now().toString(36)}`),

    /**
     * Immutable task version to which this proposal applies.
     */
    taskVersion: z.number().int().positive().default(1),

    /**
     * Deterministic digest binding this proposal's content.
     */
    proposalDigest: z.string().min(1).max(128).optional(),

    /**
     * High-level summary of the architectural changes and intent.
     */
    summary: z.string().min(1, 'Plan summary cannot be empty').max(2000),

    /**
     * Detailed explanation of the approach and reasoning.
     */
    explanation: z.string().max(10_000).optional(),

    /**
     * List of file modifications included in this plan (max 100 files).
     */
    edits: z.array(FileEditSchema).max(100).default([]),

    /**
     * Preconditions that must be satisfied before these edits may be applied.
     */
    preconditions: z.array(BaseContentPreconditionSchema).max(100).default([]),

    /**
     * Total count of files modified. If provided, must strictly match edits.length.
     */
    totalFiles: z.number().int().nonnegative().optional(),
  })
  .superRefine((plan, ctx) => {
    // Check for duplicate normalized paths
    const seenPaths = new Set<string>();
    for (let i = 0; i < plan.edits.length; i++) {
      const edit = plan.edits[i];
      try {
        const normalized = normalizeWorkspacePath(edit.path);
        if (seenPaths.has(normalized)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['edits', i, 'path'],
            message: `Duplicate normalized file path in proposal: ${normalized}`,
          });
        }
        seenPaths.add(normalized);
      } catch {
        // Path normalization issues already captured by FileEditSchema
      }
    }

    // Inconsistent file count check
    if (plan.totalFiles !== undefined && plan.totalFiles !== plan.edits.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalFiles'],
        message: `Inconsistent file count: totalFiles (${plan.totalFiles}) does not match edits.length (${plan.edits.length})`,
      });
    }
  });

export type MultiFileEditPlan = z.infer<typeof MultiFileEditPlanSchema>;

/**
 * Creates an authoritative proposal with automatically computed proposalDigest and normalized totalFiles.
 */
export function createProposal(input: {
  summary: string;
  edits: FileEdit[];
  taskVersion?: number;
  proposalId?: string;
  explanation?: string;
  preconditions?: BaseContentPrecondition[];
}): MultiFileEditPlan {
  const version = input.taskVersion ?? 1;
  const digest = computeProposalDigest(input.edits, version);

  return MultiFileEditPlanSchema.parse({
    proposalId: input.proposalId ?? `prop_${Date.now().toString(36)}`,
    taskVersion: version,
    proposalDigest: digest,
    summary: input.summary,
    explanation: input.explanation,
    edits: input.edits,
    preconditions: input.preconditions ?? [],
    totalFiles: input.edits.length,
  });
}

/**
 * Decision returned by the user when prompted to approve an edit plan.
 */
export const EditApprovalDecisionSchema = z.enum(['approved', 'rejected']);
export type EditApprovalDecision = z.infer<typeof EditApprovalDecisionSchema>;

/**
 * User response approving or rejecting proposed changes.
 * Strictly bound to an immutable proposalDigest and taskVersion to prevent stale approvals.
 */
export const EditApprovalResponseSchema = z.object({
  /**
   * ID of the task being reviewed.
   */
  taskId: z.string().min(1, 'Task ID cannot be empty').max(128),

  /**
   * Expected task version being approved. Rejects stale approvals if version has incremented.
   */
  taskVersion: z.number().int().positive('Task version must be a positive integer'),

  /**
   * Digest of the specific proposal being approved. Rejects approval if proposal has mutated.
   */
  proposalDigest: z.string().min(1, 'Proposal digest cannot be empty').max(128),

  /**
   * Overall decision: 'approved' or 'rejected'.
   */
  decision: EditApprovalDecisionSchema,

  /**
   * Specific file paths approved for application (if approving a subset of edits).
   */
  approvedPaths: z.array(z.string().min(1).max(500)).max(100).optional(),

  /**
   * Optional base-content preconditions affirmed by the approver.
   */
  preconditions: z.array(BaseContentPreconditionSchema).max(100).optional(),

  /**
   * Optional developer feedback or correction prompt on rejection.
   */
  feedback: z.string().max(5000).optional(),

  /**
   * ISO 8601 timestamp when the user responded.
   */
  respondedAt: z.string().datetime(),
});

export type EditApprovalResponse = z.infer<typeof EditApprovalResponseSchema>;
