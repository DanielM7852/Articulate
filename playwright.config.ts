import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./apps/web/e2e",
  timeout: 30000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
  webServer: [
    {
      command:
        "uv run --frozen --no-sync uvicorn app.main:app --app-dir services/api --host 127.0.0.1 --port 8000 --ws-max-size 65536 --ws-max-queue 8 --no-access-log",
      url: "http://127.0.0.1:8000/health/live",
      reuseExistingServer: !process.env.CI,
      env: {
        MOCK_MODE: "true",
        DATA_DIR: ".data/e2e",
        UV_CACHE_DIR: process.env.UV_CACHE_DIR || ".cache/uv",
      },
    },
    {
      command: "npm run dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
