import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.db.test.ts"],
    setupFiles: ["./scripts/db-test-env.ts"],
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      "@": resolve(process.cwd(), "src"),
    },
  },
});