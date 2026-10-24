import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./apps/web/e2e",
  testMatch: "vision.spec.ts",
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5175",
    headless: true,
    channel: "chrome",
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--enable-unsafe-swiftshader",
      ],
    },
  },
  webServer: {
    command:
      "npm run preview --workspace apps/web -- --port 5175 --strictPort --configLoader runner",
    url: "http://127.0.0.1:5175/vision.html",
    reuseExistingServer: !process.env.CI,
  },
});
