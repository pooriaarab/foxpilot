import { defineConfig } from "vitest/config";

// One run over every package's and app's tests.
export default defineConfig({
  test: { include: ["packages/*/tests/**/*.test.ts", "apps/*/tests/**/*.test.ts"] },
});
