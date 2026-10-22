import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Hono service owns /api (including SSE at /api/events).
// The dev server never gets a workspace path from the browser.
const apiTarget = process.env.AICHAT_API_URL ?? 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
    },
  },
  worker: { format: 'es' },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    target: ['chrome111', 'edge111', 'firefox114', 'safari16.4'],
    sourcemap: true,
  },
});
