import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import aosComponentId from './vite-plugins/aos-component-id.js';
import moduleSizes from './vite-plugins/module-sizes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));

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
  plugins: [aosComponentId({ enabled: aosDesignEnabled }), react(), moduleSizes()],
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
      // Game Wiki module — markdown rendering. Same reason as above: module
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
