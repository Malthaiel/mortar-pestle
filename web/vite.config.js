import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import aosComponentId from './vite-plugins/aos-component-id.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));

// DEV audit sink (Spacing Correctness System, Move 7) — the audit→chat bridge.
// Each webview POSTs its latest spacing/candy-center audit to /__audit; we merge it
// into web/.audit/<label>.json (per-label: a shared file gets clobbered cross-window).
// Claude reads that file instead of the user pasting console output. serve-only, no deps.
function auditSink() {
  const dir = path.resolve(__dirname, '.audit');
  return {
    name: 'audit-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__audit', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        let body = '';
        req.on('data', (c) => { body += c; });          // Vite doesn't pre-parse bodies
        req.on('end', () => {
          try {
            const msg = JSON.parse(body || '{}');
            const label = String(msg.label || 'main').replace(/[^a-z0-9-]/gi, '') || 'main';
            const file = path.join(dir, `${label}.json`);
            let prior = {};
            try { prior = JSON.parse(readFileSync(file, 'utf-8')); } catch { /* first write */ }
            const kind = String(msg.kind || 'spacing').replace(/[^a-z]/gi, '') || 'spacing';
            const merged = { ...prior, label, nonce: msg.nonce, ts: msg.ts, route: msg.route, open: msg.open, [kind]: msg.data };
            mkdirSync(dir, { recursive: true });
            writeFileSync(file, JSON.stringify(merged, null, 2));
            res.statusCode = 204; res.end();
          } catch { res.statusCode = 400; res.end(); }
        });
      });
    },
  };
}

// DEV command slot — the RETURN half of the audit bridge (Planner Button Sizing,
// 2026-08-10). /__audit carries measurements OUT of the window; this carries an
// instruction IN, so a surface can be OPENED and MEASURED without the user
// driving the mouse and reporting the result in prose. That prose loop is what
// killed the Planner sizing chat: six edits, zero measurements, three rounds of
// eyeballing, because the modal under edit was never on screen when an audit ran.
//
// Deliberately dumb: no queue, no state, no POST. The command IS a file
// (web/.audit/cmd.txt — .txt, NOT .js, so Vite's watcher can never mistake it
// for a module and full-reload the window mid-measurement) written with the
// ordinary Write tool; this endpoint just
// hands back its text plus its mtime as the id. The client runs an id once and
// remembers it, so re-serving the same file is a no-op and a rewrite is a new
// command. Client half + result path: web/src/util/remote.js.
//
// serve-only, and Vite's dev server binds 127.0.0.1 — the slot does not exist in
// the NSIS bundle. It accepts any JS from anything local, which on a single-user
// desktop grants no authority the terminal doesn't already have.
function cmdSlot() {
  const file = path.resolve(__dirname, '.audit', 'cmd.txt');
  return {
    name: 'cmd-slot',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__cmd', (req, res) => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        try {
          res.end(JSON.stringify({ id: statSync(file).mtimeMs, js: readFileSync(file, 'utf-8') }));
        } catch { res.end('{}'); }   // no command file yet — the normal resting state
      });
    },
  };
}

// SF1 of Design Mode — inject component-identity attrs on JSX. Default on; opt out with AOS_DESIGN=0.
const aosDesignEnabled = process.env.AOS_DESIGN !== '0';

// Windows port (SF5) — target OS for build-time platform gating in
// module-loader.js / DevTab.jsx. We develop on the OS we ship, so the build
// host's process.platform IS the target; override with VITE_TARGET_OS to
// cross-build. Normalized to 'windows' | 'macos' | 'linux'.
const targetOs = process.env.VITE_TARGET_OS
  || (process.platform === 'win32' ? 'windows'
    : process.platform === 'darwin' ? 'macos' : 'linux');

export default defineConfig({
  plugins: [aosComponentId({ enabled: aosDesignEnabled }), react(), auditSink(), cmdSlot()],
  define: {
    'import.meta.env.PACKAGE_VERSION': JSON.stringify(pkg.version),
    'import.meta.env.VITE_TARGET_OS': JSON.stringify(targetOs),
  },
  resolve: {
    alias: {
      '@modules': path.resolve(__dirname, '../modules'),
      '@host': path.resolve(__dirname, 'src'),
      // Explicit aliases for node_modules deps that the Skills + Terminal
      // modules import. Without these, Rollup's node-resolve walks up from
      // modules/core/<name>/ and can't find web/node_modules. Pinning the
      // path avoids any duplicate-React-style hazards from a second resolve.
      '@xterm/xterm': path.resolve(__dirname, 'node_modules/@xterm/xterm'),
      '@xterm/addon-fit': path.resolve(__dirname, 'node_modules/@xterm/addon-fit'),
      // SF8 — module-side Tauri imports (skills runner Channel + invoke).
      // Subpath imports like `@tauri-apps/api/core` resolve under this prefix.
      '@tauri-apps/api': path.resolve(__dirname, 'node_modules/@tauri-apps/api'),
      // Video Editor (studio) — module-side open()/save() pickers.
      '@tauri-apps/plugin-dialog': path.resolve(__dirname, 'node_modules/@tauri-apps/plugin-dialog'),
      // Deadlock module — markdown rendering. Same reason as above: module
      // files live outside web/, so bare imports must be pinned to
      // web/node_modules (subpaths resolve under the prefix).
      'react-markdown': path.resolve(__dirname, 'node_modules/react-markdown'),
      'remark-gfm': path.resolve(__dirname, 'node_modules/remark-gfm'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    fs: {
      allow: ['..'],
    },
    // Don't feed the audit sink's own writes back to the HMR watcher (a non-imported
    // JSON wouldn't trigger a reload anyway, but keep chokidar clean).
    watch: {
      ignored: ['**/.audit/**'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  esbuild: {
    loader: 'jsx',
    include: /(?:src|modules)\/.*\.(js|jsx)$/,
  },
  optimizeDeps: {
    include: ['react-markdown', 'remark-gfm'],
    esbuildOptions: {
      loader: { '.js': 'jsx' },
    },
  },
});
