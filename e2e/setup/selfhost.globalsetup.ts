// Boot the selfhost target: claim this checkout's port atomically
// (src/ports.ts), then run the shared boot recipe (selfhost.boot.ts — the
// same one the dev CLI uses). Set E2E_SELFHOST_URL to attach to a running
// instance (with E2E_SELFHOST_ADMIN_EMAIL/PASSWORD matching it).
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { claimAndBoot } from "../src/ports";
import { SELFHOST_ADMIN } from "../targets/selfhost";
import { waitForHttp } from "./boot";
import { bootSelfhost } from "./selfhost.boot";
import { RUNS_DIR } from "../src/scenario";

// vite dev stdout/stderr, swept into the failure-only artifact upload (CI
// uploads e2e/runs/**): see .github/workflows/ci.yml and cloud.globalsetup.ts
// for the same pattern. Skip when E2E_VERBOSE=1 so local verbose runs keep
// their inherited, live-in-terminal output (boot.ts prioritizes logFile over
// E2E_VERBOSE).
const bootLogFile = process.env.E2E_VERBOSE
  ? undefined
  : resolve(RUNS_DIR, "selfhost", ".server", "boot.log");

export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (process.env.E2E_SELFHOST_URL) {
    await waitForHttp(process.env.E2E_SELFHOST_URL);
    return;
  }

  if (bootLogFile) mkdirSync(resolve(bootLogFile, ".."), { recursive: true });

  // Claim a free port (preferred block first, walk forward past squatters),
  // boot, and retry on EADDRINUSE (a Linux-CI ephemeral socket can grab a
  // claimed port between probe and bind). The claimed port is published via env
  // so the test workers derive the same URL; the imported targets/selfhost
  // constants were computed BEFORE the claim — don't use them for ports here.
  const { teardown } = await claimAndBoot(
    [{ envVar: "E2E_SELFHOST_PORT", offset: 4, label: "selfhost vite dev" }],
    async (ports) => {
      const port = ports.E2E_SELFHOST_PORT!;
      // Fresh data dir per suite run — hermetic; in-suite isolation comes from
      // fresh identities, not resets (bootSelfhost wipes it).
      const procs = await bootSelfhost({
        port,
        webBaseUrl: `http://localhost:${port}`,
        admin: SELFHOST_ADMIN,
        logFile: bootLogFile,
      });
      return { teardown: procs.teardown, value: procs };
    },
    { label: "selfhost" },
  );
  return teardown;
}
