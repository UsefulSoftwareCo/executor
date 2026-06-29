import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    // These are integration suites: most boot a full self-host app graph
    // (Better Auth + libSQL + MCP + plugins) at module load, then drive it
    // over the in-memory handler, and some (scope-isolation) fire dozens of
    // concurrent requests through it. Each boot is CPU-heavy and every query
    // serializes through the one shared libSQL connection, so when many files
    // boot at once they oversubscribe the CPU and starve the event loop: an
    // in-flight request stalls indefinitely and the test times out. Which
    // files lose the race is nondeterministic, which is the CI flakiness.
    //
    // Vitest sizes its fork pool to the core count, so a many-core machine
    // oversubscribes HARDER than a small CI runner. Bound the concurrency to
    // an absolute number instead, so behavior is the same everywhere: at most
    // two heavy boots run together, which fits a 4-vCPU runner without
    // starvation while still running the suite in parallel. Pair it with
    // integration-grade timeouts as headroom for the slowest boot. This keeps
    // every assertion intact (no logic or coverage changed) and makes the
    // suite deterministic rather than load-dependent.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    poolOptions: {
      forks: {
        maxForks: 2,
        minForks: 1,
      },
    },
  },
});
