import type { Plugin, ViteDevServer, ResolvedConfig } from 'vite';
import { SourceRegistry } from './source-registry.js';
import { instrumentJsx } from './jsx-transform.js';
import { createBridgeMiddleware } from './bridge.js';
import type { SummonFixerPluginOptions } from './types.js';

export * from './types.js';
export { SourceRegistry } from './source-registry.js';
export { instrumentJsx } from './jsx-transform.js';
export { createBridgeMiddleware, isLoopbackUrl } from './bridge.js';

const VIRTUAL_CLIENT_ID = '/@summon-overlay/client.js';
const RESOLVED_VIRTUAL_CLIENT_ID = '\0summon-overlay:client.js';

/**
 * Summon Fixer Vite Plugin.
 *
 * Provides:
 * 1. Development-only overlay injection (strictly excluded from production builds).
 * 2. Same-origin bridge middleware forwarding /__summon/v1/* to loopback engine.
 * 3. Verified JSX element-to-source instrumentation and server-side mapping registry.
 */
export function summonFixer(options: SummonFixerPluginOptions = {}): Plugin {
  const registry = new SourceRegistry();
  let isProduction = false;
  let root = process.cwd();

  return {
    name: 'summon-fixer',
    enforce: 'pre',

    configResolved(config: ResolvedConfig) {
      isProduction = config.command === 'build' || config.mode === 'production';
      root = config.root;
    },

    resolveId(id: string) {
      if (isProduction) return null;
      if (id === VIRTUAL_CLIENT_ID || id.startsWith(VIRTUAL_CLIENT_ID)) {
        return RESOLVED_VIRTUAL_CLIENT_ID;
      }
      return null;
    },

    load(id: string) {
      if (isProduction) return null;
      if (id === RESOLVED_VIRTUAL_CLIENT_ID) {
        // Virtual client entrypoint importing and auto-mounting the isolated overlay
        return `
          import { initOverlay } from '@summon-fixer/overlay';
          if (typeof window !== 'undefined') {
            initOverlay({
              apiPrefix: ${JSON.stringify(options.apiPrefix || '/__summon/v1')},
            });
          }
        `;
      }
      return null;
    },

    /**
     * Injects the overlay script tag strictly during development mode.
     * Guaranteed: 0 bytes injected during production builds.
     */
    transformIndexHtml(html: string) {
      if (isProduction) {
        return html;
      }

      return [
        {
          tag: 'script',
          attrs: {
            type: 'module',
            src: VIRTUAL_CLIENT_ID,
            'data-summon-ignore': 'true',
          },
          injectTo: 'body',
        },
      ];
    },

    /**
     * Instruments JSX/TSX in dev mode to bind verified source mappings.
     * Excluded from production builds.
     */
    transform(code: string, id: string) {
      if (isProduction || options.instrumentJsx === false) {
        return null;
      }

      return instrumentJsx(code, id, registry, { root });
    },

    /**
     * Attaches the secure same-origin browser bridge middleware to the Vite dev server.
     */
    configureServer(server: ViteDevServer) {
      if (isProduction) return;

      const bridgeMiddleware = createBridgeMiddleware(options, registry, root);
      server.middlewares.use(bridgeMiddleware);
    },

    /**
     * Clears cached source mappings when files are hot reloaded.
     */
    handleHotUpdate({ file }) {
      if (!isProduction) {
        registry.invalidateFile(file);
      }
    },
  };
}

export default summonFixer;
