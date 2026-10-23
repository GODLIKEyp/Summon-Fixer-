import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export class WorkspaceResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceResolutionError';
  }
}

/**
 * Resolves the project workspace root from the current working directory.
 * Strictly verifies the presence of package.json without scanning arbitrary
 * filesystem hierarchies.
 */
export function resolveWorkspaceRoot(startDir: string = process.cwd()): string {
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
