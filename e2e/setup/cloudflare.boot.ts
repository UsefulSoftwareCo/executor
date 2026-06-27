// The Cloudflare host boot recipe: the REAL worker on workerd via `wrangler dev`
// (Miniflare) with a local D1 + R2. A loopback Cloudflare Access issuer signs
// real human and service-token assertions, so the worker's production JWT/JWKS
// boundary stays enabled in hermetic runs. Shared by the vitest globalsetup.
//
// The browser scenarios drive the console `/resume` page, which the worker
// serves as Static Assets from `dist/` — so the SPA is built first (vite build,
// a couple of seconds) before wrangler serves it.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  accessAssertionHeaders,
  E2E_CLOUDFLARE_ACCESS_AUDIENCE,
  verifyCloudflareAccessEmulator,
} from "../src/cloudflare-access-emulator";
import { bootProcesses, waitForHttp, type BootedProcesses } from "./boot";

export const cloudflareDir = fileURLToPath(new URL("../../apps/host-cloudflare/", import.meta.url));
const wranglerBin = fileURLToPath(
  new URL("../../apps/host-cloudflare/node_modules/.bin/wrangler", import.meta.url),
);
const accessEmulator = fileURLToPath(
  new URL("../scripts/cloudflare-access-emulator.ts", import.meta.url),
);
const e2eDir = fileURLToPath(new URL("../", import.meta.url));

export interface CloudflareBootOptions {
  readonly port: number;
  readonly accessPort: number;
  readonly logFile?: string;
  /** Skip the SPA build when `dist/` is already current (fast local iteration). */
  readonly skipBuild?: boolean;
}

export const bootCloudflare = async (options: CloudflareBootOptions): Promise<BootedProcesses> => {
  if (!options.skipBuild) {
    await promisify(execFile)("bun", ["run", "build"], { cwd: cloudflareDir });
  }

  const bootNonce = randomUUID();
  const procs = bootProcesses(
    [
      {
        cmd: process.env.E2E_BUN_BIN ?? "bun",
        args: [
          accessEmulator,
          "--port",
          String(options.accessPort),
          "--audience",
          E2E_CLOUDFLARE_ACCESS_AUDIENCE,
          "--boot-nonce",
          bootNonce,
        ],
        cwd: e2eDir,
        logFile: options.logFile,
      },
      {
        // Run wrangler under Node, not Bun. Wrangler rejects the Bun runtime for
        // workerd dev server websockets.
        // Access + the secret key arrive as `--var` overrides so the worker
        // needs no Cloudflare account while retaining the production auth gate.
        cmd: process.env.E2E_NODE_BIN ?? "node",
        args: [
          wranglerBin,
          "dev",
          "--port",
          String(options.port),
          "--ip",
          "127.0.0.1",
          "--var",
          "ACCESS_TEAM_DOMAIN:access.e2e.local",
          "--var",
          `ACCESS_ISSUER_URL:http://127.0.0.1:${options.accessPort}`,
          "--var",
          `ACCESS_AUD:${E2E_CLOUDFLARE_ACCESS_AUDIENCE}`,
          "--var",
          "ADMIN_EMAILS:admin@e2e.test",
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
    const accessBaseUrl = `http://127.0.0.1:${options.accessPort}`;
    await procs.waitUntilReady(
      (async () => {
        await waitForHttp(`${accessBaseUrl}/health`, { expectedStatus: 200 });
        const verified = await verifyCloudflareAccessEmulator(accessBaseUrl, {
          expectedBootNonce: bootNonce,
        });
        // A 200 here proves the worker fetched this boot's emulator JWKS and
        // accepted the configured issuer and audience. An unrelated listener
        // or anonymous 401 cannot false-pass boot.
        await waitForHttp(`http://127.0.0.1:${options.port}/api/account/me`, {
          timeoutMs: 120_000,
          expectedStatus: 200,
          headers: accessAssertionHeaders(verified.token),
        });
      })(),
    );
  } catch (error) {
    await procs.teardown();
    throw error;
  }
  return procs;
};
