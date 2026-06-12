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
      // The Electron desktop app. Only desktop/** scenarios — the desktop
      // target provides none of the standard surfaces (each scenario
      // launches its own app via Playwright's electron driver), so running
      // the cross-target suite here would just emit a page of skips. Needs
      // a display; not part of the default `npm run test` chain.
      project("desktop", {
        include: ["desktop/**/*.test.ts"],
        fileParallelism: false,
        testTimeout: 300_000,
      }),
      // Real-inference evals (EVAL=1; see evals/EVALS.md). Selfhost target,
      // real OpenCode binary, Go-subscription models. Burns quota and takes
      // minutes per model — on-demand / nightly, never the PR path.
      {
        test: {
          name: "evals",
          include: ["evals/**/*.test.ts"],
          env: { E2E_TARGET: "selfhost" },
          globalSetup: ["./setup/selfhost.globalsetup.ts"],
          testTimeout: 360_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
