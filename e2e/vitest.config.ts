import { defineConfig } from "vitest/config";

// One project per target. Same scenario files, different running instance:
// `vitest run --project cloud` / `--project selfhost` (or both, the default).
// Each project's globalsetup boots that app's OWN dev server (or attaches to
// E2E_<TARGET>_URL). Scenarios are isolated by fresh identities, not resets.
const project = (name: string, overrides: Record<string, unknown> = {}) => ({
  test: {
    name,
    include: ["scenarios/**/*.test.ts", `${name}/**/*.test.ts`],
    env: { E2E_TARGET: name },
    globalSetup: [`./setup/${name}.globalsetup.ts`],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    ...overrides,
  },
});

export default defineConfig({
  test: {
    projects: [
      // PGlite's socket server is effectively single-connection; parallel test
      // files (each fanning out per-request postgres sockets) crash it. Run
      // files serially — swap PGlite for real Postgres if wall-clock matters.
      project("cloud", { fileParallelism: false }),
      // selfhost identities are the shared bootstrap admin for now — run files
      // serially until per-test invite-signup isolation lands.
      project("selfhost", { fileParallelism: false }),
    ],
  },
});
