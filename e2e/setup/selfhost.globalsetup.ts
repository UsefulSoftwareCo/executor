// Boot the selfhost target: claim this checkout's port atomically
// (src/ports.ts), then run the shared boot recipe (selfhost.boot.ts — the
// same one the dev CLI uses). Set E2E_SELFHOST_URL to attach to a running
// instance (with E2E_SELFHOST_ADMIN_EMAIL/PASSWORD matching it).
import { claimAndBoot } from "../src/ports";
import { SELFHOST_ADMIN } from "../targets/selfhost";
import { waitForHttp } from "./boot";
import { bootSelfhost } from "./selfhost.boot";

export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (process.env.E2E_SELFHOST_URL) {
    await waitForHttp(process.env.E2E_SELFHOST_URL);
    return;
  }

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
      });
      return { teardown: procs.teardown, value: procs };
    },
    { label: "selfhost" },
  );
  return teardown;
}
