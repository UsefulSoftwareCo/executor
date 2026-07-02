import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    // These are integration suites: several files boot a full self-host app
    // graph (Better Auth + libSQL + MCP + plugins) in beforeAll, then drive it
    // over the in-memory handler. Each boot is CPU-heavy and every query
    // serializes through the one shared libSQL connection, so parallel files can
    // oversubscribe CI and starve in-flight requests. Run files serially and
    // give lifecycle hooks room for the cold graph boot.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
