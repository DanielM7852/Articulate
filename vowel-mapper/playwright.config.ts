import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const preview = process.env.MAPPER_PREVIEW === '1';
// MAPPER_PORT lets a second checkout run its own server instead of reusing another checkout's.
const port = Number(process.env.MAPPER_PORT) || (preview ? 5174 : 5173);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/setup.ts',
  fullyParallel: false,
  use: {
    baseURL,
    browserName: 'chromium',
    permissions: ['microphone'],
    launchOptions: { args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${resolve('node_modules/.cache/microphone.wav')}`,
    ] },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npm run ${preview ? 'preview' : 'dev'} -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI && !preview,
  },
});
