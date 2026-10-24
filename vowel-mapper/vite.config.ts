import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Optional: MAPPER_PORT=5175 npm run dev (or preview). Unset keeps Vite's defaults.
  server: { port: Number(process.env.MAPPER_PORT) || undefined, strictPort: Boolean(process.env.MAPPER_PORT) },
  preview: { port: Number(process.env.MAPPER_PORT) || undefined, strictPort: Boolean(process.env.MAPPER_PORT) },
  test: { include: ['tests/**/*.test.ts'] },
});
