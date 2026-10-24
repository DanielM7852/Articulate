import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 2026-10-23: the comment below expected a future /api proxy. /v1 now proxies to the FastAPI app.
// server: { proxy: { '/api': 'http://localhost:8000', '/ws': { target: 'ws://localhost:8000', ws: true } } }
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/v1': 'http://127.0.0.1:8000',
    },
  },
});
