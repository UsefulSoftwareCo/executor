// The selfhost boot recipe — ONE definition shared by the vitest globalsetup
// (ephemeral, torn down with the suite) and the dev CLI (persistent, lives
// until `down`). The app owns its dev stack; this owns the env contract.
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bootProcesses, waitForHttp, type BootedProcesses } from "./boot";

export const selfhostDir = fileURLToPath(new URL("../../apps/host-selfhost/", import.meta.url));

export interface SelfhostBootOptions {
  readonly port: number;
  /** The URL the app advertises (cookies, redirects). */
  readonly webBaseUrl: string;
  readonly admin: { readonly email: string; readonly password: string };
  /** Defaults to the suite's throwaway dir. */
  readonly dataDir?: string;
  /** Wipe the data dir before boot (hermetic). Default true. */
  readonly fresh?: boolean;
  /** vite --host (e.g. "0.0.0.0" to be tailnet-reachable). */
  readonly host?: string;
  readonly logFile?: string;
}

export const bootSelfhost = async (options: SelfhostBootOptions): Promise<BootedProcesses> => {
  const dataDir = options.dataDir ?? resolve(selfhostDir, ".e2e-data");
  if (options.fresh ?? true) rmSync(dataDir, { recursive: true, force: true });

  const procs = bootProcesses(
    [
      {
        cmd: "bunx",
        args: [
          "--bun",
          "vite",
          "dev",
          "--port",
          String(options.port),
          "--strictPort",
          ...(options.host ? ["--host", options.host] : []),
        ],
        cwd: selfhostDir,
        env: {
          EXECUTOR_DATA_DIR: dataDir,
          BETTER_AUTH_SECRET: "executor-selfhost-e2e-secret-0123456789",
          EXECUTOR_BOOTSTRAP_ADMIN_EMAIL: options.admin.email,
          EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD: options.admin.password,
          EXECUTOR_WEB_BASE_URL: options.webBaseUrl,
          // The harness boots loopback MCP/OAuth test servers and points the
          // instance at them; the hosted SSRF guard would otherwise block
          // outbound probes/dials to localhost. Hermetic test instance only.
          EXECUTOR_ALLOW_LOCAL_NETWORK: "true",
        },
        logFile: options.logFile,
      },
    ],
    { label: "selfhost" },
  );

  try {
    // Probe via `localhost`, not 127.0.0.1 — without --host, vite binds the
    // resolver's first answer for localhost (::1 on macOS), so the IPv4
    // loopback literal never answers.
    await waitForHttp(`http://localhost:${options.port}`);
  } catch (error) {
    await procs.teardown();
    throw error;
  }
  return procs;
};
