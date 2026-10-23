import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { SummonFixerPluginOptions } from './types.js';
import type { SourceRegistry } from './source-registry.js';

/**
 * Validates that a URL points strictly to a loopback interface for local security.
 */
export function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname;
    return (
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === '::1' ||
      host === '[::1]' ||
      host === '0.0.0.0'
    );
  } catch {
    return false;
  }
}

/**
 * Connect middleware providing the secure same-origin browser bridge.
 */
export function createBridgeMiddleware(
  options: SummonFixerPluginOptions,
  sourceRegistry: SourceRegistry
) {
  const apiPrefix = options.apiPrefix || '/__summon/v1';
  const rawEngineUrl =
    options.engineUrl || process.env.SUMMON_ENGINE_URL || 'http://127.0.0.1:3883';
  const engineToken =
    options.engineToken || process.env.SUMMON_ENGINE_TOKEN || '';

  const engineUrl = rawEngineUrl.replace(/\/+$/, '');
  const isLoopback = isLoopbackUrl(engineUrl);

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

    // 1. Strict route allowlist matching
    const isHealthRoute = method === 'GET' && pathname === `${apiPrefix}/health`;
    const isSourceResolveRoute =
      method === 'GET' && pathname === `${apiPrefix}/source/resolve`;
    const isCreateTaskRoute = method === 'POST' && pathname === `${apiPrefix}/tasks`;
    const isGetTaskRoute =
      method === 'GET' &&
      new RegExp(`^${apiPrefix}/tasks/([^/]+)$`).test(pathname);
    const isApprovalRoute =
      method === 'POST' &&
      new RegExp(`^${apiPrefix}/tasks/([^/]+)/approval$`).test(pathname);
    const isCancelRoute =
      method === 'POST' &&
      new RegExp(`^${apiPrefix}/tasks/([^/]+)/cancel$`).test(pathname);

    const isAllowlisted =
      isHealthRoute ||
      isSourceResolveRoute ||
      isCreateTaskRoute ||
      isGetTaskRoute ||
      isApprovalRoute ||
      isCancelRoute;

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

    // 2. Handle GET /source/resolve directly on the dev server via SourceRegistry
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

    // 3. Loopback engine target verification
    if (!isLoopback) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: {
            code: 'ERR_NON_LOOPBACK_TARGET',
            message:
              'Security violation: Summon Fixer engine must resolve to a local loopback interface.',
          },
        })
      );
      return;
    }

    // 4. Handle GET /health check
    if (isHealthRoute) {
      let engineConnected = false;
      let engineDetails = null;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1200);

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

    // 5. Read request body if present
    let bodyBuffer: Buffer | null = null;
    if (method === 'POST') {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        bodyBuffer = Buffer.concat(chunks);
      } catch (readErr) {
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

    // 6. Map bridge pathname to loopback engine path
    // Maps /__summon/v1/tasks -> ${engineUrl}/v1/tasks or ${engineUrl}/tasks
    const targetPath = pathname.slice(apiPrefix.length); // e.g. /tasks, /tasks/123/approval
    const targetUrl = `${engineUrl}${targetPath}${parsedUrl.search}`;

    const forwardHeaders: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': req.headers['content-type'] || 'application/json',
    };

    if (engineToken) {
      forwardHeaders['Authorization'] = `Bearer ${engineToken}`;
    }

    // Forward request to loopback engine
    try {
      const engineRes = await fetch(targetUrl, {
        method,
        headers: forwardHeaders,
        body: bodyBuffer ? new Uint8Array(bodyBuffer) : undefined,
      });

      const responseBody = await engineRes.text();

      res.statusCode = engineRes.status;
      const contentType = engineRes.headers.get('content-type');
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }
      res.end(responseBody);
    } catch (err: any) {
      // Disconnected engine handling
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
  };
}
