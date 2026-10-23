import { realpathSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import type { IncomingMessage } from 'node:http';
import {
  isPathAllowedByPolicy,
  normalizeWorkspacePath,
  type PermissionPolicy,
} from '@summon-fixer/contracts';

export const MAX_REQUEST_BODY_BYTES = 1024 * 1024; // 1 MB limit

export class SecurityError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 403,
    public readonly code: string = 'SECURITY_VIOLATION'
  ) {
    super(message);
    this.name = 'SecurityError';
  }
}

/**
 * Validates that a requested path is strictly contained within the canonical workspace root.
 * Resolves symlinks and rejects path traversal attempts.
 * Returns the canonical relative workspace path.
 */
export function validateWorkspaceContainment(
  workspaceRoot: string,
  candidatePath: string
): string {
  if (!workspaceRoot) {
    throw new SecurityError('Workspace root must be specified', 500, 'INVALID_WORKSPACE_ROOT');
  }

  // Canonicalize workspace root
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(resolve(workspaceRoot));
  } catch (err) {
    throw new SecurityError(
      `Failed to canonicalize workspace root: ${(err as Error).message}`,
      500,
      'INVALID_WORKSPACE_ROOT'
    );
  }

  // Reject paths containing explicit traversal sequences before resolution
  if (candidatePath.includes('..')) {
    throw new SecurityError(
      `Path traversal rejected: '${candidatePath}' contains '..'`,
      400,
      'PATH_TRAVERSAL'
    );
  }

  const resolvedTarget = isAbsolute(candidatePath)
    ? resolve(candidatePath)
    : resolve(canonicalRoot, candidatePath);

  // Check if file or existing ancestor directory escapes canonical root via symlinks
  let canonicalTargetDir: string;
  let filename: string;

  if (existsSync(resolvedTarget)) {
    try {
      const canonicalTarget = realpathSync(resolvedTarget);
      const rel = relative(canonicalRoot, canonicalTarget);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new SecurityError(
          `Symlink escape detected: '${candidatePath}' resolves outside workspace root`,
          403,
          'WORKSPACE_ESCAPE'
        );
      }
      return normalizeWorkspacePath(rel);
    } catch (err) {
      if (err instanceof SecurityError) throw err;
      throw new SecurityError(
        `Failed to resolve realpath for target: ${(err as Error).message}`,
        400,
        'CANONICALIZATION_FAILED'
      );
    }
  } else {
    // For files to be created, find closest existing ancestor directory and verify it
    let currentDir = dirname(resolvedTarget);
    while (!existsSync(currentDir) && currentDir !== dirname(currentDir)) {
      currentDir = dirname(currentDir);
    }

    try {
      canonicalTargetDir = realpathSync(currentDir);
    } catch (err) {
      throw new SecurityError(
        `Failed to resolve ancestor path: ${(err as Error).message}`,
        400,
        'CANONICALIZATION_FAILED'
      );
    }

    const relDir = relative(canonicalRoot, canonicalTargetDir);
    if (relDir.startsWith('..') || isAbsolute(relDir)) {
      throw new SecurityError(
        `Target directory resides outside workspace root: '${candidatePath}'`,
        403,
        'WORKSPACE_ESCAPE'
      );
    }

    const relTarget = relative(canonicalRoot, resolvedTarget);
    if (relTarget.startsWith('..') || isAbsolute(relTarget)) {
      throw new SecurityError(
        `Path resolves outside workspace root: '${candidatePath}'`,
        403,
        'WORKSPACE_ESCAPE'
      );
    }

    return normalizeWorkspacePath(relTarget);
  }
}

/**
 * Validates whether an edit target is permitted by the engine's active permission policy.
 */
export function validateEditPolicy(
  normalizedPath: string,
  policy: PermissionPolicy
): void {
  const allowed = isPathAllowedByPolicy(normalizedPath, policy);
  if (!allowed) {
    throw new SecurityError(
      `Access to '${normalizedPath}' is denied by the active permission policy`,
      403,
      'POLICY_DENIED'
    );
  }
}

/**
 * Validates Host, Origin, and Authorization headers for incoming loopback engine requests.
 */
export function validateLoopbackRequest(
  req: IncomingMessage,
  expectedToken: string
): { valid: true } | { valid: false; statusCode: number; code: string; message: string } {
  // 1. Host validation: MUST be 127.0.0.1 or localhost
  const host = req.headers.host;
  if (!host) {
    return {
      valid: false,
      statusCode: 400,
      code: 'MISSING_HOST',
      message: 'Host header is required',
    };
  }

  const hostname = host.split(':')[0]?.toLowerCase() ?? '';
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    return {
      valid: false,
      statusCode: 403,
      code: 'INVALID_HOST',
      message: `Access denied: host '${hostname}' is not a permitted loopback address`,
    };
  }

  // 2. Origin validation: If present, must be loopback http://127.0.0.1:* or http://localhost:*
  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsedOrigin = new URL(origin);
      const originHost = parsedOrigin.hostname.toLowerCase();
      if (
        (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') ||
        (originHost !== '127.0.0.1' && originHost !== 'localhost')
      ) {
        return {
          valid: false,
          statusCode: 403,
          code: 'INVALID_ORIGIN',
          message: `Access denied: origin '${origin}' is not a permitted loopback origin`,
        };
      }
    } catch {
      return {
        valid: false,
        statusCode: 400,
        code: 'MALFORMED_ORIGIN',
        message: 'Malformed Origin header',
      };
    }
  }

  // 3. Bearer Token Authentication
  const authHeader = req.headers.authorization;
  const tokenHeader = req.headers['x-summon-token'];

  let providedToken: string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    providedToken = authHeader.slice(7).trim();
  } else if (typeof tokenHeader === 'string') {
    providedToken = tokenHeader.trim();
  }

  if (!providedToken) {
    return {
      valid: false,
      statusCode: 401,
      code: 'UNAUTHORIZED',
      message: 'Missing engine authorization token',
    };
  }

  if (providedToken !== expectedToken) {
    return {
      valid: false,
      statusCode: 401,
      code: 'UNAUTHORIZED',
      message: 'Invalid engine authorization token',
    };
  }

  return { valid: true };
}
