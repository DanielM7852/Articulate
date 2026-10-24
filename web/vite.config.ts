import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The measurement backend (FastAPI + Parselmouth) can be proxied here once it exists:
// server: { proxy: { '/api': 'http://localhost:8000', '/ws': { target: 'ws://localhost:8000', ws: true } } }
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true },
});
