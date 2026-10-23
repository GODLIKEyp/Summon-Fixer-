import { z } from 'zod';

/**
 * Line range in a source file.
 */
export const LineRangeSchema = z.object({
  start: z.number().int().positive(),
  end: z.number().int().positive(),
}).refine((range) => range.end >= range.start, {
  message: 'LineRange end must be greater than or equal to start',
});
export type LineRange = z.infer<typeof LineRangeSchema>;

/**
 * Context regarding an active or referenced file.
 * Includes optional opaque sourceId and revision tags for reliable snapshot binding.
 */
export const FileContextSchema = z.object({
  /**
   * Workspace-relative file path.
   */
  path: z.string().min(1, 'File path cannot be empty').max(500, 'File path exceeds maximum length'),

  /**
   * Opaque client-side source identifier (e.g. editor document URI, tab identifier, or buffer ID).
   */
  sourceId: z.string().min(1).max(256).optional(),

  /**
   * Opaque revision or content hash representing the file state seen by the client.
   */
  revision: z.string().min(1).max(128).optional(),

  /**
   * Focused line or line range in the editor, if applicable.
   */
  lineRange: LineRangeSchema.optional(),

  /**
   * Selected snippet or highlighted code. Bounded to prevent oversized payloads.
   */
  selectedText: z.string().max(50_000, 'Selected text exceeds maximum length of 50,000 characters').optional(),

  /**
   * In-memory file content snapshot at invocation time (if unsaved changes exist).
   */
  contentSnapshot: z.string().max(100_000, 'Content snapshot exceeds maximum length of 100,000 characters').optional(),
});
export type FileContext = z.infer<typeof FileContextSchema>;

/**
 * Opaque source/revision selection specification.
 * Allows the browser overlay or editor to indicate a specific snapshot or buffer revision.
 */
export const SourceSelectionSchema = z.object({
  /**
   * Opaque identifier representing the source buffer, document, or git tree.
   */
  sourceId: z.string().min(1, 'Source ID cannot be empty').max(256),

  /**
   * Opaque version tag, git SHA, or sequence number.
   */
  revision: z.string().min(1).max(128).optional(),

  /**
   * Optional human-readable description of this source revision.
   */
  description: z.string().max(500).optional(),
});
export type SourceSelection = z.infer<typeof SourceSelectionSchema>;

/**
 * Visual and runtime UI context captured by the browser overlay or dev inspector.
 */
export const UIContextSchema = z.object({
  /**
   * Name of the React/Vue/Svelte component clicked or inspected.
   */
  componentName: z.string().max(256).optional(),

  /**
   * CSS selector of the focused DOM element.
   */
  elementSelector: z.string().max(1000).optional(),

  /**
   * Browser URL / route where the task was summoned.
   */
  renderedUrl: z.string().max(2000).optional(),

  /**
   * Runtime error message if triggered by an uncaught error or error boundary.
   */
  errorMessage: z.string().max(5000).optional(),

  /**
   * Stack trace associated with an error or component mount.
   */
  stackTrace: z.string().max(50_000).optional(),
});
export type UIContext = z.infer<typeof UIContextSchema>;

/**
 * Metadata regarding the client application summoning the task.
 * Note: Workspace root and effective filesystem paths are strictly engine-owned.
 */
export const ClientContextSchema = z.object({
  /**
   * Client type triggering the task.
   */
  clientType: z.enum(['overlay', 'cli', 'ide', 'api']).default('overlay'),

  /**
   * Client user agent or extension version string.
   */
  clientVersion: z.string().max(128).optional(),

  /**
   * Client-reported active Git branch, if known.
   */
  gitBranch: z.string().max(256).optional(),

  /**
   * Client-reported active Git commit hash, if known.
   */
  gitCommit: z.string().max(128).optional(),
});
export type ClientContext = z.infer<typeof ClientContextSchema>;

/**
 * Unified context payload attached to an untrusted task request.
 */
export const TaskContextSchema = z.object({
  /**
   * Primary active file in focus.
   */
  activeFile: FileContextSchema.optional(),

  /**
   * Additional relevant or inspected files (bounded to 100 entries).
   */
  relevantFiles: z.array(FileContextSchema).max(100).default([]),

  /**
   * Opaque source selection / revision target.
   */
  sourceSelection: SourceSelectionSchema.optional(),

  /**
   * Browser UI inspection context.
   */
  ui: UIContextSchema.optional(),

  /**
   * Client environment metadata.
   */
  client: ClientContextSchema.optional(),

  /**
   * Extensible custom metadata key-values.
   */
  metadata: z.record(z.unknown()).optional(),
});
export type TaskContext = z.infer<typeof TaskContextSchema>;
