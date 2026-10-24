import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { safeValidateTaskRequest } from '@summon-fixer/contracts';
import type { SummonFixerPluginOptions } from './types.js';
import type { SourceRegistry } from './source-registry.js';

export const MAX_REQUEST_BODY_BYTES = 1024 * 1024; // 1 MB limit

/**
 * Validates that a URL points strictly to a local loopback interface.
 * Rejects 0.0.0.0, non-loopback IPs, and external domains.
 */
export function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    return (
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === '::1' ||
      host === '[::1]'
    );
  } catch {
    return false;
  }
}

/**
 * Resolves the canonical repository / project workspace root.
 */
function resolveProjectWorkspaceRoot(optionsRoot?: string): string {
  if (optionsRoot) {
    try {
      return realpathSync(resolve(optionsRoot));
    } catch {
      return resolve(optionsRoot);
    }
  }

  if (process.env.SUMMON_WORKSPACE_ROOT) {
    try {
      return realpathSync(resolve(process.env.SUMMON_WORKSPACE_ROOT));
    } catch {
      return resolve(process.env.SUMMON_WORKSPACE_ROOT);
    }
  }

  // Scan upward from cwd looking for a package.json containing "workspaces"
  let cur = process.cwd();
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

  try {
    return realpathSync(process.cwd());
  } catch {
    return process.cwd();
  }
}

/**
 * Connect middleware providing the secure same-origin browser bridge.
 */
export function createBridgeMiddleware(
  options: SummonFixerPluginOptions,
  sourceRegistry: SourceRegistry,
  serverRoot?: string
) {
  const apiPrefix = options.apiPrefix || '/__summon/v1';
  const rawEngineUrl =
    options.engineUrl || process.env.SUMMON_ENGINE_URL || 'http://127.0.0.1:3883';
  const engineToken =
    options.engineToken || process.env.SUMMON_ENGINE_TOKEN || '';

  const engineUrl = rawEngineUrl.replace(/\/+$/, '');
  const isLoopback = isLoopbackUrl(engineUrl);

  const viteRoot = serverRoot || process.cwd();
  const workspaceRoot = resolveProjectWorkspaceRoot(options.workspaceRoot);

  return async function bridgeMiddleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void
  ) {
    const reqUrl = req.url || '';
    if (!reqUrl.startsWith(apiPrefix)) {
      return next();
    }

    // Parse URL and path
    const parsedUrl = new URL(reqUrl, 'http://localhost');
    const pathname = parsedUrl.pathname;
    const method = (req.method || 'GET').toUpperCase();

    // 1. Enforce browser-origin check for cross-origin defense
    const headers = req.headers || {};
    const origin = headers.origin;
    if (origin) {
      try {
        const originUrl = new URL(origin);
        const originHost = originUrl.hostname.toLowerCase();
        const reqHost = (headers.host || '').split(':')[0].toLowerCase();
        const isPermittedOrigin =
          originHost === '127.0.0.1' ||
          originHost === 'localhost' ||
          originHost === reqHost;

        if (!isPermittedOrigin) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: {
                code: 'ERR_FORBIDDEN_ORIGIN',
                message: `Cross-origin request from '${origin}' rejected by Summon Fixer bridge.`,
              },
            })
          );
          return;
        }
      } catch {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              code: 'ERR_MALFORMED_ORIGIN',
              message: 'Invalid Origin header format.',
            },
          })
        );
        return;
      }
    }

    // 2. Strict route allowlist matching
    const isHealthRoute = method === 'GET' && pathname === `${apiPrefix}/health`;
    const isSourceResolveRoute =
      method === 'GET' && pathname === `${apiPrefix}/source/resolve`;
    const isCreateTaskRoute = method === 'POST' && pathname === `${apiPrefix}/tasks`;

    const getTaskMatch = pathname.match(new RegExp(`^${apiPrefix}/tasks/([^/]+)$`));
    const isGetTaskRoute = method === 'GET' && Boolean(getTaskMatch);

    const approvalMatch = pathname.match(
      new RegExp(`^${apiPrefix}/tasks/([^/]+)/(?:approval|apply)$`)
    );
    const isApprovalRoute = method === 'POST' && Boolean(approvalMatch);

    const cancelMatch = pathname.match(new RegExp(`^${apiPrefix}/tasks/([^/]+)/cancel$`));
    const isCancelRoute = method === 'POST' && Boolean(cancelMatch);

    // Reject unsupported cancellation explicitly
    if (isCancelRoute) {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: {
            code: 'ERR_UNSUPPORTED_OPERATION',
            message: 'Task cancellation is not supported by the Summon Fixer engine.',
          },
        })
      );
      return;
    }

    const isAllowlisted =
      isHealthRoute ||
      isSourceResolveRoute ||
      isCreateTaskRoute ||
      isGetTaskRoute ||
      isApprovalRoute;

    if (!isAllowlisted) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: {
            code: 'ERR_ROUTE_NOT_ALLOWLISTED',
            message: `Route '${method} ${pathname}' is not in the Summon Fixer bridge allowlist.`,
          },
        })
      );
      return;
    }

    // 3. Handle GET /source/resolve directly on the dev server via SourceRegistry
    if (isSourceResolveRoute) {
      const sourceId = parsedUrl.searchParams.get('sourceId');
      if (!sourceId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              code: 'ERR_MISSING_SOURCE_ID',
              message: 'Query parameter "sourceId" is required.',
            },
          })
        );
        return;
      }

      const mapping = sourceRegistry.resolve(sourceId);
      if (!mapping) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              code: 'ERR_SOURCE_NOT_FOUND',
              message: `No verified source mapping found for sourceId '${sourceId}'.`,
            },
          })
        );
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(mapping));
      return;
    }

    // 4. Loopback engine target verification
    if (!isLoopback) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: {
            code: 'ERR_NON_LOOPBACK_TARGET',
            message:
              'Security violation: Summon Fixer engine must resolve strictly to a local loopback interface (127.0.0.1 or localhost).',
          },
        })
      );
      return;
    }

    // 5. Handle GET /health check
    if (isHealthRoute) {
      let engineConnected = false;
      let engineDetails = null;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1500);

        const checkHeaders: Record<string, string> = { Accept: 'application/json' };
        if (engineToken) {
          checkHeaders['Authorization'] = `Bearer ${engineToken}`;
        }

        const engineHealthRes = await fetch(`${engineUrl}/health`, {
          method: 'GET',
          headers: checkHeaders,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (engineHealthRes.ok) {
          engineConnected = true;
          engineDetails = await engineHealthRes.json().catch(() => null);
        }
      } catch {
        engineConnected = false;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          status: 'ok',
          bridge: 'ready',
          engineConnected,
          engineUrl,
          engineDetails,
        })
      );
      return;
    }

    // 6. Read request body if present with strict size limit
    let bodyBuffer: Buffer | null = null;
    if (method === 'POST') {
      try {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        for await (const chunk of req) {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          totalBytes += buf.length;
          if (totalBytes > MAX_REQUEST_BODY_BYTES) {
            res.statusCode = 413;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                error: {
                  code: 'ERR_PAYLOAD_TOO_LARGE',
                  message: `Request payload exceeds limit of ${MAX_REQUEST_BODY_BYTES} bytes.`,
                },
              })
            );
            return;
          }
          chunks.push(buf);
        }
        bodyBuffer = Buffer.concat(chunks);
      } catch {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              code: 'ERR_BAD_REQUEST_BODY',
              message: 'Failed to read request payload.',
            },
          })
        );
        return;
      }
    }

    const forwardHeaders: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    if (engineToken) {
      forwardHeaders['Authorization'] = `Bearer ${engineToken}`;
    }

    // 7. Handle POST /tasks -> engine POST /v1/tasks with internal envelope
    if (isCreateTaskRoute) {
      let rawJson: unknown;
      try {
        rawJson = bodyBuffer && bodyBuffer.length > 0 ? JSON.parse(bodyBuffer.toString('utf-8')) : {};
      } catch {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              code: 'ERR_MALFORMED_JSON',
              message: 'Malformed JSON payload in task creation request.',
            },
          })
        );
        return;
      }

      const validatedReq = safeValidateTaskRequest(rawJson);
      if (!validatedReq.success) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              code: 'ERR_INVALID_TASK_REQUEST',
              message: 'Task request payload failed schema validation.',
              details: validatedReq.error.format(),
            },
          })
        );
        return;
      }

      const taskRequest = validatedReq.data;

      // Resolve source IDs exclusively from trusted server-side SourceRegistry
      // Do NOT derive authoritative source paths from browser activeFile, metadata, or selectors
      const sourceId = taskRequest.context?.sourceSelection?.sourceId;
      const sourceHints: Array<{
        filePath: string;
        lineRange?: { start: number; end: number };
        componentName?: string;
        elementTag?: string;
        textContent?: string;
      }> = [];

      if (sourceId) {
        const mapping = sourceRegistry.resolve(sourceId);
        if (mapping) {
          // Resolve relative path to canonical engine workspace root
          let targetAbsPath = mapping.absolutePath
            ? resolve(mapping.absolutePath)
            : resolve(viteRoot, mapping.file);
          try {
            targetAbsPath = realpathSync(targetAbsPath);
          } catch {
            // keep resolved target path
          }

          const workspaceRelativePath = relative(workspaceRoot, targetAbsPath).replace(/\\/g, '/');

          const elementContext = taskRequest.context?.metadata?.elementContext as
            | Record<string, unknown>
            | undefined;

          sourceHints.push({
            filePath: workspaceRelativePath,
            lineRange: {
              start: mapping.line,
              end: mapping.line,
            },
            componentName: mapping.elementTag,
            elementTag: mapping.elementTag,
            textContent:
              typeof elementContext?.textContent === 'string'
                ? elementContext.textContent
                : undefined,
          });

          // Ensure targetFiles points to the verified workspace-relative path if not provided
          if (!taskRequest.targetFiles || taskRequest.targetFiles.length === 0) {
            taskRequest.targetFiles = [workspaceRelativePath];
          }
        }
      }

      const envelope = {
        request: taskRequest,
        sourceHints: sourceHints.length > 0 ? sourceHints : undefined,
      };

      try {
        const engineRes = await fetch(`${engineUrl}/v1/tasks`, {
          method: 'POST',
          headers: forwardHeaders,
          body: JSON.stringify(envelope),
        });

        const engineData = (await engineRes.json().catch(() => ({}))) as any;

        res.statusCode = engineRes.status;
        res.setHeader('Content-Type', 'application/json');

        if (!engineRes.ok) {
          res.end(JSON.stringify(engineData));
          return;
        }

        // Normalize response so client receives { taskId, state, task }
        const task = engineData.task || engineData;
        res.end(
          JSON.stringify({
            taskId: task.taskId,
            state: task,
            task,
          })
        );
      } catch (err: any) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              code: 'ERR_ENGINE_DISCONNECTED',
              message: `Summon Fixer engine is not reachable at ${engineUrl}. Ensure the localhost engine daemon is running.`,
              details: err?.message || 'Connection refused',
            },
          })
        );
      }
      return;
    }

    // 8. Handle GET /tasks/:id -> engine GET /v1/tasks/:id
    if (isGetTaskRoute && getTaskMatch) {
      const taskId = getTaskMatch[1];
      const targetUrl = `${engineUrl}/v1/tasks/${encodeURIComponent(taskId)}`;

      try {
        const engineRes = await fetch(targetUrl, {
          method: 'GET',
          headers: forwardHeaders,
        });

        const engineData = (await engineRes.json().catch(() => ({}))) as any;

        res.statusCode = engineRes.status;
        res.setHeader('Content-Type', 'application/json');

        if (!engineRes.ok) {
          res.end(JSON.stringify(engineData));
          return;
        }

        const task = engineData.task || engineData;
        res.end(
          JSON.stringify({
            ...task,
            task,
          })
        );
      } catch (err: any) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              code: 'ERR_ENGINE_DISCONNECTED',
              message: `Summon Fixer engine is not reachable at ${engineUrl}. Ensure the localhost engine daemon is running.`,
              details: err?.message || 'Connection refused',
            },
          })
        );
      }
      return;
    }

    // 9. Handle POST /tasks/:id/approval or /apply -> engine POST /v1/tasks/:id/apply
    if (isApprovalRoute && approvalMatch) {
      const taskId = approvalMatch[1];
      const targetUrl = `${engineUrl}/v1/tasks/${encodeURIComponent(taskId)}/apply`;

      let rawJson: unknown;
      try {
        rawJson = bodyBuffer && bodyBuffer.length > 0 ? JSON.parse(bodyBuffer.toString('utf-8')) : {};
      } catch {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              code: 'ERR_MALFORMED_JSON',
              message: 'Malformed JSON payload in approval request.',
            },
          })
        );
        return;
      }

      // Forward approval payload wrapped in apply envelope or direct
      const forwardBody = (rawJson as any)?.approval ? rawJson : { approval: rawJson };

      try {
        const engineRes = await fetch(targetUrl, {
          method: 'POST',
          headers: forwardHeaders,
          body: JSON.stringify(forwardBody),
        });

        const engineData = (await engineRes.json().catch(() => ({}))) as any;

        res.statusCode = engineRes.status;
        res.setHeader('Content-Type', 'application/json');

        if (!engineRes.ok) {
          res.end(JSON.stringify(engineData));
          return;
        }

        const task = engineData.task || engineData;
        res.end(
          JSON.stringify({
            success: true,
            state: task,
            task,
          })
        );
      } catch (err: any) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              code: 'ERR_ENGINE_DISCONNECTED',
              message: `Summon Fixer engine is not reachable at ${engineUrl}. Ensure the localhost engine daemon is running.`,
              details: err?.message || 'Connection refused',
            },
          })
        );
      }
      return;
    }
  };
}
