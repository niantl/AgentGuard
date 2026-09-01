import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Each test file owns its own snapshot/audit files on disk; running files in
    // separate forks keeps the single-instance snapshot assumption honest.
    pool: "forks",
    poolOptions: { forks: { singleFork: false } },
    testTimeout: 20_000,
  },
});
