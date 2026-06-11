// Boot the cloud target: WorkOS + Autumn EMULATORS (in this process, from the
// vendored emulate fork) plus the app's own dev stack (PGlite dev-db + vite
// dev) pointed at them via WORKOS_API_URL / AUTUMN_API_URL. The app runs its
// REAL auth/billing code — real SDKs, real sealed-session crypto, real JWKS —
// against emulated services. Set E2E_CLOUD_URL to attach to a running stack.
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Vendored fork import (same pattern as mcporter).
import { createEmulator } from "@executor-js/emulate";

import { bootProcesses, waitForHttp } from "./boot";
import {
  CLOUD_BASE_URL,
  CLOUD_DB_PORT,
  CLOUD_PORT,
  WORKOS_EMULATOR_PORT,
  AUTUMN_EMULATOR_PORT,
  E2E_WORKOS_CLIENT_ID,
  E2E_COOKIE_PASSWORD,
} from "../targets/cloud";

const cloudDir = fileURLToPath(new URL("../../apps/cloud/", import.meta.url));

export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (process.env.E2E_CLOUD_URL) {
    await waitForHttp(process.env.E2E_CLOUD_URL);
    return;
  }

  // Fresh dev DB per suite run — hermetic, like the selfhost data dir. The
  // WorkOS emulator mints org ids from a per-process counter, so a persisted
  // DB from a previous invocation collides with the new boot's ids (identities
  // land in polluted orgs / org creation 500s).
  const dbPath = resolve(cloudDir, ".e2e-stub-db");
  rmSync(dbPath, { recursive: true, force: true });

  // MCP access tokens minted by the emulator's OAuth server must carry the
  // app's client id as audience (what the resource server verifies).
  process.env.EMULATE_WORKOS_AUDIENCE = E2E_WORKOS_CLIENT_ID;
  const workos = await createEmulator({ service: "workos", port: WORKOS_EMULATOR_PORT });
  const autumn = await createEmulator({ service: "autumn", port: AUTUMN_EMULATOR_PORT });

  const env = {
    // Real client, emulated service.
    WORKOS_API_URL: workos.url,
    AUTUMN_API_URL: autumn.url,
    WORKOS_API_KEY: "sk_test_emulate",
    WORKOS_CLIENT_ID: E2E_WORKOS_CLIENT_ID,
    WORKOS_COOKIE_PASSWORD: E2E_COOKIE_PASSWORD,
    AUTUMN_SECRET_KEY: "am_test_emulate",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${CLOUD_DB_PORT}/postgres`,
    EXECUTOR_DIRECT_DATABASE_URL: "true",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
    VITE_PUBLIC_SITE_URL: CLOUD_BASE_URL,
    // The AuthKit domain (MCP OAuth metadata + JWKS) is the emulator too.
    MCP_AUTHKIT_DOMAIN: workos.url,
    MCP_RESOURCE_ORIGIN: CLOUD_BASE_URL,
    ALLOW_LOCAL_NETWORK: "true",
    // Throwaway PGlite on its own port + dir so it never fights `bun dev`.
    DEV_DB_PORT: String(CLOUD_DB_PORT),
    DEV_DB_PATH: dbPath,
  };

  const procs = bootProcesses(
    [
      { cmd: "bun", args: ["run", "scripts/dev-db.ts"], cwd: cloudDir, env },
      {
        cmd: "bunx",
        args: ["vite", "dev", "--port", String(CLOUD_PORT), "--strictPort", "--host", "127.0.0.1"],
        cwd: cloudDir,
        env,
      },
    ],
    { label: "cloud" },
  );

  try {
    await waitForHttp(CLOUD_BASE_URL);
    // The API plane is ready when login actually redirects to AuthKit.
    await waitForHttp(`${CLOUD_BASE_URL}/api/auth/login`, { expectRedirect: true });
  } catch (error) {
    await procs.teardown();
    await workos.close();
    await autumn.close();
    throw error;
  }
  return async () => {
    await procs.teardown();
    await workos.close();
    await autumn.close();
  };
}
