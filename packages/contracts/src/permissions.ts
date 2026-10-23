import { z } from 'zod';

/**
 * Permission mode controlling Codex and Summon Fixer execution autonomy.
 *
 * - `plan`: Read-only analysis. Proposes plans and multi-file diffs without modifying files or executing shell commands.
 * - `manual`: Interactive step-by-step mode. Proposes changes and halts for explicit user approval before applying diffs.
 * - `auto`: Autonomous execution within predefined workspace boundaries and policy limits.
 *
 * Note: While 'plan' and 'manual' are the primary active modes for Phase 1,
 * the contract is designed to seamlessly support 'auto' permissions in future milestones.
 */
export const PermissionModeSchema = z.enum(['plan', 'manual', 'auto']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/**
 * Default patterns for strictly protected paths.
 * Protects .env and all .env.* secret files while explicitly allowing .env.example.
 */
export const DEFAULT_DISALLOWED_PATHS: readonly string[] = Object.freeze([
  'node_modules/**',
  '.git/**',
  '.env',
  '.env.*',
  '!.env.example',
  '**/*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

export const DEFAULT_ALLOWED_PATHS: readonly string[] = Object.freeze(['.']);

/**
 * Granular policy governing what operations Codex is permitted to perform.
 * Owned and enforced exclusively by the engine; untrusted browser clients cannot override this.
 */
export const PermissionPolicySchema = z.object({
  /**
   * Execution autonomy mode.
   */
  mode: PermissionModeSchema.default('plan'),

  /**
   * Relative workspace path patterns or directories where edits are permitted.
   */
  allowedPaths: z.array(z.string().min(1).max(500)).default(() => [...DEFAULT_ALLOWED_PATHS]),

  /**
   * Relative workspace path patterns strictly forbidden from modification.
   * Protects secret configuration while allowing sample files like .env.example.
   */
  disallowedPaths: z.array(z.string().min(1).max(500)).default(() => [...DEFAULT_DISALLOWED_PATHS]),

  /**
   * Whether shell commands may be executed by the runner.
   */
  allowShellExecution: z.boolean().default(false),

  /**
   * Whether the runner is permitted to create new files.
   */
  allowFileCreation: z.boolean().default(true),

  /**
   * Whether the runner is permitted to delete existing files.
   */
  allowFileDeletion: z.boolean().default(false),

  /**
   * Maximum number of files permitted to be edited within a single task changeset.
   */
  maxFilesPerTask: z.number().int().positive().max(100).default(10),

  /**
   * Whether diffs require explicit user confirmation before disk writes occur.
   */
  requireDiffApproval: z.boolean().default(true),
});

export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

/**
 * Deep recursive freeze helper to guarantee immutability of baseline configurations.
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj as object)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

/**
 * Baseline default policies corresponding to each permission mode.
 * Guaranteed deeply immutable so runtime callers cannot pollute shared state.
 */
export const DEFAULT_PERMISSION_POLICIES: Readonly<Record<PermissionMode, Readonly<PermissionPolicy>>> = deepFreeze({
  plan: {
    mode: 'plan',
    allowedPaths: [...DEFAULT_ALLOWED_PATHS],
    disallowedPaths: [...DEFAULT_DISALLOWED_PATHS],
    allowShellExecution: false,
    allowFileCreation: false,
    allowFileDeletion: false,
    maxFilesPerTask: 20,
    requireDiffApproval: true,
  },
  manual: {
    mode: 'manual',
    allowedPaths: [...DEFAULT_ALLOWED_PATHS],
    disallowedPaths: [...DEFAULT_DISALLOWED_PATHS],
    allowShellExecution: false,
    allowFileCreation: true,
    allowFileDeletion: false,
    maxFilesPerTask: 10,
    requireDiffApproval: true,
  },
  auto: {
    mode: 'auto',
    allowedPaths: [...DEFAULT_ALLOWED_PATHS],
    disallowedPaths: [...DEFAULT_DISALLOWED_PATHS],
    allowShellExecution: false,
    allowFileCreation: true,
    allowFileDeletion: false,
    maxFilesPerTask: 5,
    requireDiffApproval: false,
  },
});

/**
 * Returns an independent, deeply cloned copy of the default permission policy
 * for a given permission mode, ensuring caller modifications do not contaminate the baseline.
 */
export function getDefaultPermissionPolicy(mode: PermissionMode = 'plan'): PermissionPolicy {
  return structuredClone(DEFAULT_PERMISSION_POLICIES[mode]) as PermissionPolicy;
}

/**
 * Checks whether a given relative normalized path is permitted by the given policy.
 * Specifically ensures `.env.example` is allowed while all `.env` and `.env.*` secrets are rejected.
 */
export function isPathAllowedByPolicy(normalizedPath: string, policy: PermissionPolicy): boolean {
  // Disallow directory traversal or absolute paths
  if (
    normalizedPath.startsWith('/') ||
    normalizedPath.startsWith('\\') ||
    normalizedPath.includes('..')
  ) {
    return false;
  }

  const basename = normalizedPath.split('/').pop() ?? normalizedPath;

  // Explicit exception: .env.example is safe to read/modify if in allowed path
  const isEnvExample = basename === '.env.example';

  // Protect secret env files
  if (!isEnvExample && (basename === '.env' || basename.startsWith('.env.'))) {
    return false;
  }

  // Protect git and node_modules
  if (
    normalizedPath.startsWith('.git/') ||
    normalizedPath === '.git' ||
    normalizedPath.startsWith('node_modules/') ||
    normalizedPath === 'node_modules'
  ) {
    return false;
  }

  // Protect lockfiles
  if (
    basename === 'package-lock.json' ||
    basename === 'pnpm-lock.yaml' ||
    basename === 'yarn.lock' ||
    basename.endsWith('.lock')
  ) {
    return false;
  }

  // Check custom disallowed paths
  for (const pattern of policy.disallowedPaths) {
    if (pattern === '!.env.example') {
      continue;
    }
    if (pattern === normalizedPath || (pattern.endsWith('/**') && normalizedPath.startsWith(pattern.slice(0, -3)))) {
      return false;
    }
  }

  // Check allowed paths
  if (policy.allowedPaths.includes('.')) {
    return true;
  }

  return policy.allowedPaths.some(
    (allowed) =>
      normalizedPath === allowed ||
      normalizedPath.startsWith(allowed.endsWith('/') ? allowed : `${allowed}/`)
  );
}
