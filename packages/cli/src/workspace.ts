import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export class WorkspaceResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceResolutionError';
  }
}

/**
 * Resolves the project workspace root from the current working directory.
 * Scans upward to find the monorepo root (package.json with workspaces)
 * or validates the presence of package.json.
 */
export function resolveWorkspaceRoot(startDir: string = process.cwd()): string {
  // Check upward for monorepo root with workspaces definition
  let cur = resolve(startDir);
  while (cur !== dirname(cur)) {
    const candidate = resolve(cur, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
        if (pkg.workspaces) {
          return realpathSync(cur);
        }
      } catch {
        // continue search
      }
    }
    cur = dirname(cur);
  }

  const targetDir = resolve(startDir);
  const packageJsonPath = resolve(targetDir, 'package.json');

  if (!existsSync(packageJsonPath)) {
    throw new WorkspaceResolutionError(
      `Cannot resolve project workspace: no package.json found in '${targetDir}'. ` +
      `Summon Fixer must be run from the root of a project.`
    );
  }

  try {
    return realpathSync(targetDir);
  } catch (err) {
    throw new WorkspaceResolutionError(
      `Failed to canonicalize workspace path '${targetDir}': ${(err as Error).message}`
    );
  }
}
