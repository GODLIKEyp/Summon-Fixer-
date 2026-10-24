import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startEngine, type EngineInstance } from '@summon-fixer/runner';
import { resolveWorkspaceRoot } from './workspace.js';

export interface DevCommandOptions {
  cwd?: string;
  port?: number;
  useFakeRunner?: boolean;
  command?: string;
  engineOnly?: boolean;
  verificationCommand?: string;
}

export interface DevSession {
  engine: EngineInstance;
  childProcess?: ChildProcess;
  stop(): Promise<void>;
}

/**
 * Runs the `summon dev` command:
 * 1. Resolves and validates the workspace root from cwd.
 * 2. Launches the local loopback engine.
 * 3. Injects SUMMON_ENGINE_URL and SUMMON_ENGINE_TOKEN into the child dev process.
 * 4. Cleans up all child processes on shutdown.
 */
export async function runDev(options: DevCommandOptions = {}): Promise<DevSession> {
  const workspaceRoot = resolveWorkspaceRoot(options.cwd);

  // Start engine bound exclusively to 127.0.0.1
  const engine = await startEngine({
    workspaceRoot,
    port: options.port ?? 7890,
    useFakeRunner: options.useFakeRunner,
    verificationCommand: options.verificationCommand,
  });

  console.log(`[summon] Local engine running at ${engine.url}`);
  console.log(`[summon] Workspace root: ${workspaceRoot}`);
  console.log(`[summon] Mode: ${engine.server.executor ? 'active' : 'idle'}`);

  let child: ChildProcess | undefined;
  let isStopping = false;

  const stopSession = async () => {
    if (isStopping) return;
    isStopping = true;

    if (child && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore kill error
      }
    }

    try {
      await engine.close();
      console.log('[summon] Engine stopped gracefully.');
    } catch {
      // ignore close error
    }
  };

  // Register process termination handlers
  const onSignal = () => {
    stopSession().then(() => {
      process.exit(0);
    });
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  if (options.engineOnly) {
    return {
      engine,
      stop: stopSession,
    };
  }

  // Determine dev command to run
  let cmdToRun = options.command;
  if (!cmdToRun) {
    const pkgPath = resolve(workspaceRoot, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.scripts && pkg.scripts.dev) {
          cmdToRun = 'npm run dev';
        }
      } catch {
        // Fall back to no child command
      }
    }
  }

  if (cmdToRun) {
    console.log(`[summon] Starting dev process: '${cmdToRun}'...`);
    const env = {
      ...process.env,
      SUMMON_WORKSPACE_ROOT: workspaceRoot,
      SUMMON_ENGINE_URL: engine.url,
      SUMMON_ENGINE_TOKEN: engine.token,
    };

    child = spawn(cmdToRun, {
      cwd: workspaceRoot,
      env,
      shell: true,
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      stopSession().then(() => {
        if (code !== 0 && code !== null) {
          process.exit(code);
        }
      });
    });

    child.on('error', (err) => {
      console.error(`[summon] Child process error: ${err.message}`);
      stopSession();
    });
  } else {
    console.log('[summon] No dev command detected in package.json. Running engine in standalone mode.');
  }

  return {
    engine,
    childProcess: child,
    stop: stopSession,
  };
}
