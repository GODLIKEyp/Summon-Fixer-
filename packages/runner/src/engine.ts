import { randomBytes } from 'node:crypto';
import { EngineServer, type EngineServerOptions } from './server.js';
import { RealCodexRunner, FakeCodexRunner, type CodexRunnerInterface } from './codex/index.js';

export interface StartEngineOptions {
  host?: string;
  port?: number;
  token?: string;
  workspaceRoot: string;
  runner?: CodexRunnerInterface;
  useFakeRunner?: boolean;
  verificationCommand?: string;
}

export interface EngineInstance {
  url: string;
  host: string;
  port: number;
  token: string;
  server: EngineServer;
  close(): Promise<void>;
}

/**
 * Starts a local engine instance bound strictly to 127.0.0.1.
 */
export async function startEngine(options: StartEngineOptions): Promise<EngineInstance> {
  const token = options.token ?? randomBytes(24).toString('hex');
  const runner =
    options.runner ??
    (options.useFakeRunner ? new FakeCodexRunner() : new RealCodexRunner());

  const server = new EngineServer({
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 0,
    token,
    workspaceRoot: options.workspaceRoot,
    runner,
    verificationCommand: options.verificationCommand,
  });

  const { host, port, url } = await server.start();

  return {
    url,
    host,
    port,
    token,
    server,
    close: async () => {
      await server.stop();
    },
  };
}
