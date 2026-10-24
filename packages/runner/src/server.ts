import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  safeValidateTaskRequest,
  EditApprovalResponseSchema,
} from '@summon-fixer/contracts';
import {
  validateLoopbackRequest,
  MAX_REQUEST_BODY_BYTES,
  SecurityError,
} from './security.js';
import { TaskEnvelopeSchema, ApplyEnvelopeSchema } from './envelope.js';
import { TaskExecutor, TaskExecutionError } from './executor.js';
import type { CodexRunnerInterface } from './codex/types.js';

export interface EngineServerOptions {
  host?: string;
  port?: number;
  token: string;
  workspaceRoot: string;
  runner: CodexRunnerInterface;
  verificationCommand?: string;
  verificationTimeoutMs?: number;
  proposalTimeoutMs?: number;
}

export class EngineServer {
  public readonly host: string;
  public readonly port: number;
  public readonly token: string;
  public readonly executor: TaskExecutor;
  private server: Server | null = null;

  constructor(private readonly options: EngineServerOptions) {
    // Engine MUST bind strictly to 127.0.0.1
    this.host = options.host ?? '127.0.0.1';
    if (this.host !== '127.0.0.1') {
      throw new SecurityError(
        `Engine service must be bound strictly to 127.0.0.1, got: '${this.host}'`,
        500,
        'INVALID_BIND_HOST'
      );
    }
    this.port = options.port ?? 0; // 0 for automatic port selection
    this.token = options.token;

    this.executor = new TaskExecutor({
      workspaceRoot: options.workspaceRoot,
      runner: options.runner,
      verificationCommand: options.verificationCommand,
      verificationTimeoutMs: options.verificationTimeoutMs,
      proposalTimeoutMs: options.proposalTimeoutMs,
    });
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => {
        void this.handleRequest(req, res).catch((err) => this.handleError(err, res));
      });

      srv.on('error', (err) => {
        reject(err);
      });

      srv.listen(this.port, this.host, () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          this.server = srv;
          const assignedPort = addr.port;
          const url = `http://${this.host}:${assignedPort}`;
          resolve({ host: this.host, port: assignedPort, url });
        } else {
          reject(new Error('Failed to obtain server address'));
        }
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    // Stop accepting connections first, abort active jobs, then bound draining
    // slow clients. No background proposal is allowed to outlive close().
    const closed = new Promise<void>((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
    const drain = setTimeout(() => server?.closeAllConnections(), 1500);
    try { await this.executor.close(); await closed; }
    finally { clearTimeout(drain); }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try { url = new URL(req.url ?? '/', `http://${this.host}`); }
    catch {
      this.sendJson(res, 400, { error: { code: 'MALFORMED_REQUEST_TARGET', message: 'Invalid HTTP request target' } });
      return;
    }
    const pathname = url.pathname;
    const method = req.method?.toUpperCase() ?? 'GET';

    // Set standard JSON & security headers
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Summon-Token');

    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    // Health check route: permits unauthenticated loopback probe
    if (pathname === '/health' || pathname === '/v1/health') {
      const loopbackCheck = validateLoopbackRequest(req, this.token);
      // For health check, verify host/origin even if token omitted
      const host = req.headers.host?.split(':')[0]?.toLowerCase();
      if (host !== '127.0.0.1' && host !== 'localhost') {
        this.sendJson(res, 403, {
          error: { code: 'INVALID_HOST', message: 'Host must be loopback' },
        });
        return;
      }

      this.sendJson(res, 200, {
        status: 'ok',
        engine: 'summon-fixer',
        runnerMode: this.options.runner.mode,
        automaticApplyAvailable: false,
        applicationUnavailableCode: 'SAFE_WRITE_UNAVAILABLE',
      });
      return;
    }

    // All /v1/* endpoints require loopback validation and authentication
    const authCheck = validateLoopbackRequest(req, this.token);
    if (!authCheck.valid) {
      this.sendJson(res, authCheck.statusCode, {
        error: { code: authCheck.code, message: authCheck.message },
      });
      return;
    }

    try {
      if (method === 'POST' && pathname === '/v1/tasks') {
        await this.handleCreateTask(req, res);
      } else if (method === 'GET' && pathname.startsWith('/v1/tasks/')) {
        const taskId = pathname.slice('/v1/tasks/'.length);
        await this.handleGetTask(taskId, res);
      } else if (method === 'POST' && pathname.startsWith('/v1/tasks/') && pathname.endsWith('/apply')) {
        const parts = pathname.split('/');
        // Path: /v1/tasks/:id/apply
        const taskId = parts[3];
        if (!taskId) {
          this.sendJson(res, 400, {
            error: { code: 'BAD_REQUEST', message: 'Task ID required in path' },
          });
          return;
        }
        await this.handleApplyTask(taskId, req, res);
      } else {
        this.sendJson(res, 404, {
          error: { code: 'NOT_FOUND', message: `Route '${method} ${pathname}' not found` },
        });
      }
    } catch (err) {
      this.handleError(err, res);
    }
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let body = '';
      let bytesCount = 0;

      req.on('data', (chunk: Buffer) => {
        bytesCount += chunk.length;
        if (bytesCount > MAX_REQUEST_BODY_BYTES) {
          reject(
            new SecurityError(
              `Request body exceeded maximum limit of ${MAX_REQUEST_BODY_BYTES} bytes`,
              413,
              'PAYLOAD_TOO_LARGE'
            )
          );
          req.destroy();
          return;
        }
        body += chunk.toString('utf-8');
      });

      req.on('end', () => {
        if (!body.trim()) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(body);
          resolve(parsed);
        } catch {
          reject(new TaskExecutionError('Malformed JSON request body', 400, 'MALFORMED_JSON'));
        }
      });

      req.on('error', (err) => {
        reject(err);
      });
    });
  }

  private async handleCreateTask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await this.readJsonBody(req);

    // Accept either the authenticated internal envelope or a direct task request wrapped in envelope
    let envelopeResult = TaskEnvelopeSchema.safeParse(rawBody);

    if (!envelopeResult.success) {
      // Check if rawBody was directly a TaskRequest without wrapper envelope
      const directRequest = safeValidateTaskRequest(rawBody);
      if (directRequest.success) {
        envelopeResult = TaskEnvelopeSchema.safeParse({ request: directRequest.data });
      } else {
        this.sendJson(res, 400, {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Invalid task request payload',
            details: envelopeResult.error.format(),
          },
        });
        return;
      }
    }

    if (!envelopeResult.success) {
      this.sendJson(res, 400, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Invalid task envelope',
          details: envelopeResult.error.format(),
        },
      });
      return;
    }

    const task = await this.executor.createTask(envelopeResult.data);
    this.sendJson(res, 201, { task });
  }

  private async handleGetTask(taskId: string, res: ServerResponse): Promise<void> {
    const cleanId = decodeURIComponent(taskId);
    const task = this.executor.getTask(cleanId);
    if (!task) {
      this.sendJson(res, 404, {
        error: { code: 'TASK_NOT_FOUND', message: `Task '${cleanId}' not found` },
      });
      return;
    }

    this.sendJson(res, 200, { task });
  }

  private async handleApplyTask(
    taskId: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const cleanId = decodeURIComponent(taskId);
    const rawBody = await this.readJsonBody(req);

    // Accept either ApplyEnvelope { approval: ... } or direct approval payload
    let approvalPayload: unknown;
    const envelopeResult = ApplyEnvelopeSchema.safeParse(rawBody);
    if (envelopeResult.success) {
      approvalPayload = envelopeResult.data.approval;
    } else {
      approvalPayload = rawBody;
    }

    const approvalValidation = EditApprovalResponseSchema.safeParse(approvalPayload);
    if (!approvalValidation.success) {
      this.sendJson(res, 400, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Invalid approval response payload',
          details: approvalValidation.error.format(),
        },
      });
      return;
    }

    if (approvalValidation.data.taskId !== cleanId) {
      this.sendJson(res, 400, {
        error: {
          code: 'TASK_ID_MISMATCH',
          message: `Approval body taskId ('${approvalValidation.data.taskId}') does not match URL task ID ('${cleanId}')`,
        },
      });
      return;
    }

    try {
      const task = await this.executor.applyApproval(cleanId, approvalValidation.data);
      this.sendJson(res, 200, { task });
    } catch (error) {
      if (error instanceof TaskExecutionError || error instanceof SecurityError) {
        this.sendJson(res, error.statusCode, { error: { code: error.code, message: error.message },
          task: this.executor.getTask(cleanId) });
      } else throw error;
    }
  }

  private handleError(err: unknown, res: ServerResponse): void {
    if (res.headersSent) return;

    if (err instanceof URIError) {
      this.sendJson(res, 400, { error: { code: 'MALFORMED_REQUEST_TARGET', message: 'Invalid HTTP request target' } });
      return;
    }
    if (err instanceof SecurityError) {
      this.sendJson(res, err.statusCode, {
        error: { code: err.code, message: err.message },
      });
      return;
    }

    if (err instanceof TaskExecutionError) {
      this.sendJson(res, err.statusCode, {
        error: { code: err.code, message: err.message },
      });
      return;
    }

    this.sendJson(res, 500, {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An internal engine error occurred',
      },
    });
  }

  private sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
    if (res.headersSent) return;
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = statusCode;
    res.end(JSON.stringify(data, null, 2));
  }
}
