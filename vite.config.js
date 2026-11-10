// Web UI build (Vite). Sources live in web/, the build goes to dist/ui/, which src/server.js serves.
//   npm run build:ui   production build (no sourcemaps; three.js is a lazy chunk for the 3D viewer)
//   npm run dev:ui     dev server with hot reload; /api (REST, ops, SSE) is proxied to a running
//                      agent-art server (AGENT_ART_URL, default http://127.0.0.1:7420)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { notices } from './scripts/vite-notices.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(here('./package.json'), 'utf8')).version;
const API = (process.env.AGENT_ART_URL || 'http://127.0.0.1:7420').replace(/\/+$/, '');
const TOKEN_META = /<meta name="agent-art-ui-token"[^>]*>/;
const isLocal = (origin) => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname); } catch { return false; } };

/**
 * Dev only: the server trusts ops with source "user" when the page carries its per-process UI
 * token and the request has its own Origin. Copy the token from the running server's page into the
 * dev page; the proxy below rewrites a local Origin to the server's.
 */
function devUiToken() {
  let warned = false;
  return {
    name: 'agent-art-dev-ui-token',
    apply: 'serve',
    async transformIndexHtml(html) {
      try {
        const meta = (await (await fetch(API + '/')).text()).match(TOKEN_META)?.[0];
        if (meta) return html.replace(/<head>/i, (h) => `${h}\n  ${meta}`);
      } catch { /* server not running */ }
      if (!warned) console.warn(`[dev:ui] no agent-art server at ${API}: start one (npm run serve) or set AGENT_ART_URL`);
      warned = true;
      return html;
    },
  };
}

/**
 * Build only: write `<outDir>/build.json` `{ version, builtAt }` after the bundle is written. The server
 * compares it with the package version and the newest web/ source mtime (src/server.js uiBuildStatus).
 */
export function buildStamp(version = VERSION, now = () => Date.now()) {
  let outDir = here('./dist/ui');
  return {
    name: 'agent-art-build-stamp',
    apply: 'build',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    closeBundle() {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'build.json'), JSON.stringify({ version, builtAt: now() }, null, 2) + `\n`);
    },
  };
}

export default defineConfig({
  root: here('./web'),
  base: './',
  publicDir: false,
  // the package version, for window.agentArt.version (web/src/main.ts)
  define: { __AGENT_ART_VERSION__: JSON.stringify(VERSION) },
  plugins: [svelte({ configFile: here('./svelte.config.js') }), devUiToken(), notices(), buildStamp()],
  resolve: {
    alias: { '@': here('./web/src') },
    conditions: process.env.VITEST ? ['browser'] : undefined,
  },
  build: {
    outDir: here('./dist/ui'),
    emptyOutDir: true,
    sourcemap: false,
    assetsDir: 'assets',
    chunkSizeWarningLimit: 800, // the lazy three.js chunk (~700 kB) is expected
    rolldownOptions: {
      output: {
        // keep /*! */ and @license notices (three.js is MIT)
        comments: { legal: true, annotation: false, jsdoc: false },
        // three.js core + the addons the 3D viewer uses: one lazy chunk, fetched when it first opens
        codeSplitting: {
          groups: [
            // (plus our three-side model code: shading rig, clusters, disposal, channel shaders, Z pie; it only runs once three is loaded, see web/src/viewers/model/shadingRig.ts)
            { name: 'three', test: /[\\/]node_modules[\\/]three[\\/]|[\\/]viewers[\\/]model[\\/](shadingRig|clusters|dispose|shaders|pie)\.ts$/, includeDependenciesRecursively: false },
            // lazy graph libraries (Svelte Flow + its d3 parts; dagre): stable names for the budget script
            { name: 'graph-cards', test: /[\\/]node_modules[\\/](@xyflow|@svelte-put|d3-[a-z]+)[\\/]/, includeDependenciesRecursively: false },
            { name: 'graph-layout', test: /[\\/]node_modules[\\/]@dagrejs[\\/]/, includeDependenciesRecursively: false },
            // the command palette (step 18b): component + item builder + fuzzysort, fetched on first open / hover of the search button
            { name: 'palette', test: /[\\/]node_modules[\\/]fuzzysort[\\/]|[\\/]components[\\/]dialogs[\\/](CommandPalette\.svelte|commands\.ts)$/, includeDependenciesRecursively: false },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: API,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.headers.origin && isLocal(req.headers.origin)) proxyReq.setHeader('origin', new URL(API).origin);
          });
        },
      },
    },
  },
  test: {
    root: here('./web'),
    include: ['**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
  },
});
