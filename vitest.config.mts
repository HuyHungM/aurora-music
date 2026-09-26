import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/*.db.test.ts"],
    setupFiles: ["src/test-setup.ts"],
  },
  resolve: {
    alias: {
      "@": resolve(process.cwd(), "src"),
    },
  },
});