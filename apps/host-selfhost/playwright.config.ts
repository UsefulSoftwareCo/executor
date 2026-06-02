import { defineConfig, devices } from "@playwright/test";

// ---------------------------------------------------------------------------
// Playwright e2e for host-selfhost — the realistic, fully-assembled suite.
//
// Boots the real prod server (e2e/server.ts → `bun run src/serve.ts`) against a
// throwaway data dir and drives it in a real browser through its real surfaces.
// Watchable: `bun run test:e2e:watch` runs headed + slowed down so you can see
// each step; `bun run test:e2e:ui` opens Playwright's time-travel UI; every run
// also writes an HTML report + trace you can replay.
// ---------------------------------------------------------------------------

const PORT = process.env.E2E_PORT ?? "4796";
const BASE_URL = `http://localhost:${PORT}`;
const slowMo = Number(process.env.E2E_SLOWMO ?? 0);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "github" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    headless: true,
    // Trace gives full time-travel replay (DOM/network/console) with no extra
    // system deps — that's the watchable artifact. (Video would need ffmpeg.)
    trace: "on",
    screenshot: "only-on-failure",
    launchOptions: { slowMo },
  },
  projects: [
    {
      name: "chromium",
      // Drive system Chrome by default (no Chromium download); CI sets
      // PLAYWRIGHT_USE_CHROMIUM=1 to use the Playwright-managed browser.
      use: process.env.PLAYWRIGHT_USE_CHROMIUM
        ? { ...devices["Desktop Chrome"] }
        : { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: {
    command: "bun run e2e/server.ts",
    url: `${BASE_URL}/api/setup-status`,
    timeout: 120_000,
    // Always boot a fresh instance — the first-run scenario requires the org to
    // start with zero members (needsSetup: true).
    reuseExistingServer: false,
    // Keep the watch run readable: suppress the server's request logs, but still
    // surface stderr so a real boot failure is visible.
    stdout: "ignore",
    stderr: "pipe",
  },
});
