import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["web/tests/live-transport.test.ts", "web/tests/articulation-identity.test.ts"] },
});
