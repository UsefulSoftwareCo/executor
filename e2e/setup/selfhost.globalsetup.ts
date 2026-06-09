// Boot the selfhost target: the app's real dev server (`bunx --bun vite dev`,
// Bun required for bun:sqlite) on a throwaway data dir with known bootstrap
// admin credentials. Set E2E_SELFHOST_URL to attach to a running instance
// (with E2E_SELFHOST_ADMIN_EMAIL/PASSWORD matching it).
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bootProcesses, waitForHttp } from "./boot";
import { SELFHOST_ADMIN, SELFHOST_BASE_URL, SELFHOST_PORT } from "../targets/selfhost";

const selfhostDir = fileURLToPath(new URL("../../apps/host-selfhost/", import.meta.url));

export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (process.env.E2E_SELFHOST_URL) {
    await waitForHttp(process.env.E2E_SELFHOST_URL);
    return;
  }

  // Fresh data dir per suite run — hermetic; in-suite isolation comes from
  // fresh identities, not resets.
  const dataDir = resolve(selfhostDir, ".e2e-data");
  rmSync(dataDir, { recursive: true, force: true });

  const procs = bootProcesses(
    [
      {
        cmd: "bunx",
        args: ["--bun", "vite", "dev", "--port", String(SELFHOST_PORT), "--strictPort"],
        cwd: selfhostDir,
        env: {
          EXECUTOR_DATA_DIR: dataDir,
          BETTER_AUTH_SECRET: "executor-selfhost-e2e-secret-0123456789",
          EXECUTOR_BOOTSTRAP_ADMIN_EMAIL: SELFHOST_ADMIN.email,
          EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD: SELFHOST_ADMIN.password,
          EXECUTOR_WEB_BASE_URL: SELFHOST_BASE_URL,
        },
      },
    ],
    { label: "selfhost" },
  );

  try {
    await waitForHttp(SELFHOST_BASE_URL);
  } catch (error) {
    await procs.teardown();
    throw error;
  }
  return procs.teardown;
}
