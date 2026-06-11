import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@executor-js/fumadb/cuid": path.resolve(import.meta.dirname, "./src/cuid.ts"),
    },
  },
  test: {
    setupFiles: ["./test/setup.ts"],
    fileParallelism: false,
    maxConcurrency: 1,
  },
});
