// The Cloudflare host boot recipe: the REAL worker on workerd via `wrangler dev`
// (Miniflare) with a local D1 + R2 and dev-auth on. Shared by the vitest
// globalsetup (ephemeral) and, like the other hosts, available to a dev CLI.
//
// The browser scenarios drive the console `/resume` page, which the worker
// serves as Static Assets from `dist/` — so the SPA is built first (vite build,
// a couple of seconds) before wrangler serves it.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { bootProcesses, waitForHttp, type BootedProcesses } from "./boot";

export const cloudflareDir = fileURLToPath(new URL("../../apps/host-cloudflare/", import.meta.url));
const wranglerBin = fileURLToPath(
  new URL("../../apps/host-cloudflare/node_modules/.bin/wrangler", import.meta.url),
);

export interface CloudflareBootOptions {
  readonly port: number;
  readonly logFile?: string;
  /** Skip the SPA build when `dist/` is already current (fast local iteration). */
  readonly skipBuild?: boolean;
}

export const bootCloudflare = async (options: CloudflareBootOptions): Promise<BootedProcesses> => {
  if (!options.skipBuild) {
    await promisify(execFile)("bun", ["run", "build"], { cwd: cloudflareDir });
  }

  const procs = bootProcesses(
    [
      {
        // Run wrangler under Node, not Bun. Wrangler rejects the Bun runtime for
        // workerd dev server websockets.
        // dev-auth + the secret key arrive as `--var` overrides so the worker
        // needs no Cloudflare account or real Access app.
        cmd: process.env.E2E_NODE_BIN ?? "node",
        args: [
          wranglerBin,
          "dev",
          "--port",
          String(options.port),
          "--ip",
          "127.0.0.1",
          "--var",
          "ENABLE_DEV_AUTH:true",
          "--var",
          "EXECUTOR_SECRET_KEY:e2e-secret-key-0123456789abcdef0123456789abcdef",
          "--var",
          "ALLOW_LOCAL_NETWORK:true",
        ],
        cwd: cloudflareDir,
        env: { WRANGLER_SEND_METRICS: "false", CI: "true" },
        logFile: options.logFile,
      },
    ],
    { label: "cloudflare" },
  );

  try {
    // dev-auth: /api/account/me answers 200 as the dev admin once the worker is
    // up (workerd boot + esbuild + D1 schema bring-up take a beat on first run).
    await waitForHttp(`http://127.0.0.1:${options.port}/api/account/me`, { timeoutMs: 120_000 });
  } catch (error) {
    await procs.teardown();
    throw error;
  }
  return procs;
};
