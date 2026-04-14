import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@distribute/runs-client": path.resolve(__dirname, "packages/runs-client/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
