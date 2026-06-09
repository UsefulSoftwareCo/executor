// Boot the cloud target: the app's OWN dev stack (PGlite dev-db + vite dev)
// with EXECUTOR_E2E_STUB=1 — the one flag that makes `vite dev` a logged-in,
// fully-stubbed instance (multi-user WorkOS stub, free-plan Autumn, no
// network). Set E2E_CLOUD_URL to attach to an already-running instance
// instead (e.g. while iterating on a scenario).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bootProcesses, waitForHttp } from "./boot";
import { CLOUD_BASE_URL, CLOUD_DB_PORT, CLOUD_PORT } from "../targets/cloud";

const cloudDir = fileURLToPath(new URL("../../apps/cloud/", import.meta.url));

export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (process.env.E2E_CLOUD_URL) {
    await waitForHttp(process.env.E2E_CLOUD_URL);
    return;
  }

  const env = {
    EXECUTOR_E2E_STUB: "1",
    // Stub creds — never contacted; the stub layers replace the clients.
    WORKOS_API_KEY: "sk_e2e_stub",
    WORKOS_CLIENT_ID: "client_e2e_stub",
    WORKOS_COOKIE_PASSWORD: "e2e_cookie_password_0123456789abcdef0123456789abcdef",
    AUTUMN_SECRET_KEY: "am_e2e_stub",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${CLOUD_DB_PORT}/postgres`,
    EXECUTOR_DIRECT_DATABASE_URL: "true",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
    VITE_PUBLIC_SITE_URL: CLOUD_BASE_URL,
    MCP_AUTHKIT_DOMAIN: "https://example.com",
    MCP_RESOURCE_ORIGIN: CLOUD_BASE_URL,
    // Throwaway PGlite on its own port + dir so it never fights `bun dev`.
    DEV_DB_PORT: String(CLOUD_DB_PORT),
    DEV_DB_PATH: resolve(cloudDir, ".e2e-stub-db"),
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
  } catch (error) {
    await procs.teardown();
    throw error;
  }
  return procs.teardown;
}
