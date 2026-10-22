import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Builds the self-contained offline reader.
 *
 * Requirements (ARCHITECTURE 10/12):
 * - dist/offline/reader.js is a single IIFE containing React and every dependency:
 *   no import statements, no code-split chunks, no external modules.
 * - dist/offline/reader.css has every url() (KaTeX fonts) inlined as data URIs.
 *
 * Deliberately no post-processing of bundle text: earlier attempts to rewrite
 * documentation URLs inside the emitted code corrupted minified literals and made
 * the reader crash at mount. Upstream strings are inert text, not dependencies.
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/offline',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
    sourcemap: false,
    target: ['chrome111', 'edge111', 'firefox114', 'safari16.4'],
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: {
      input: resolve(process.cwd(), 'src/web/offline/main.tsx'),
      output: {
        format: 'iife',
        name: 'AichatOfflineReader',
        inlineDynamicImports: true,
        entryFileNames: 'reader.js',
        assetFileNames: (asset) => (asset.names?.some((name) => name.endsWith('.css')) === true ? 'reader.css' : 'reader-[name][extname]'),
      },
    },
  },
});
