import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["apps/web/tests/vision*.test.ts"], environment: "node" },
});
