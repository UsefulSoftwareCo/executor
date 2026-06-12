// The cloud boot recipe — ONE definition shared by the vitest globalsetup
// (ephemeral) and the dev CLI (persistent): WorkOS + Autumn EMULATORS in this
// process plus the app's own dev stack (PGlite dev-db + vite dev) pointed at
// them. The app runs its REAL auth/billing code — real SDKs, real
// sealed-session crypto, real JWKS — against emulated services.
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Vendored fork import (same pattern as mcporter).
import { createEmulator } from "@executor-js/emulate";

import { bootProcesses, waitForHttp } from "./boot";

export const cloudDir = fileURLToPath(new URL("../../apps/cloud/", import.meta.url));

export interface CloudBootOptions {
  readonly cloudPort: number;
  readonly dbPort: number;
  readonly workosPort: number;
  readonly autumnPort: number;
  readonly workosClientId: string;
  readonly cookiePassword: string;
  /** The URL the app advertises (VITE_PUBLIC_SITE_URL, MCP resource origin). */
  readonly publicUrl: string;
  /**
   * The WorkOS origin the BROWSER must reach (authorize page redirects).
   * Defaults to the emulator's loopback URL; set it when a proxy (e.g.
   * `tailscale serve` HTTPS) fronts the emulator — the app's auth cookies
   * are Secure, so off-localhost access needs https on both sides.
   */
  readonly workosPublicUrl?: string;
  /** vite --host. Default 127.0.0.1. */
  readonly host?: string;
  /** Wipe the dev DB before boot (hermetic). Default true. */
  readonly fresh?: boolean;
  readonly logFile?: string;
}

export interface CloudBooted {
  readonly teardown: () => Promise<void>;
  readonly pids: ReadonlyArray<number>;
  readonly workosUrl: string;
  readonly autumnUrl: string;
}

export const bootCloud = async (options: CloudBootOptions): Promise<CloudBooted> => {
  // Fresh dev DB per boot — the WorkOS emulator mints org ids from a
  // per-process counter, so a persisted DB from a previous invocation
  // collides with the new boot's ids (identities land in polluted orgs /
  // org creation 500s).
  const dbPath = resolve(cloudDir, ".e2e-stub-db");
  if (options.fresh ?? true) rmSync(dbPath, { recursive: true, force: true });

  // MCP access tokens minted by the emulator's OAuth server must carry the
  // app's client id as audience (what the resource server verifies).
  process.env.EMULATE_WORKOS_AUDIENCE = options.workosClientId;
  const workos = await createEmulator({
    service: "workos",
    port: options.workosPort,
    ...(options.workosPublicUrl ? { baseUrl: options.workosPublicUrl } : {}),
  });
  const autumn = await createEmulator({ service: "autumn", port: options.autumnPort });

  const workosUrl = options.workosPublicUrl ?? workos.url;
  const env = {
    // Real client, emulated service. The app derives the browser-facing
    // authorize URL from WORKOS_API_URL, so it must be the PUBLIC origin.
    WORKOS_API_URL: workosUrl,
    AUTUMN_API_URL: autumn.url,
    WORKOS_API_KEY: "sk_test_emulate",
    WORKOS_CLIENT_ID: options.workosClientId,
    WORKOS_COOKIE_PASSWORD: options.cookiePassword,
    AUTUMN_SECRET_KEY: "am_test_emulate",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${options.dbPort}/postgres`,
    EXECUTOR_DIRECT_DATABASE_URL: "true",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
    VITE_PUBLIC_SITE_URL: options.publicUrl,
    // The AuthKit domain (MCP OAuth metadata + JWKS) is the emulator too.
    MCP_AUTHKIT_DOMAIN: workosUrl,
    MCP_RESOURCE_ORIGIN: options.publicUrl,
    ALLOW_LOCAL_NETWORK: "true",
    // Throwaway PGlite on its own port + dir so it never fights `bun dev`.
    DEV_DB_PORT: String(options.dbPort),
    DEV_DB_PATH: dbPath,
    // Vite rejects unknown Host headers; allow the public hostname when a
    // proxy fronts the app.
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: new URL(options.publicUrl).hostname,
  };

  const procs = bootProcesses(
    [
      {
        cmd: "bun",
        args: ["run", "scripts/dev-db.ts"],
        cwd: cloudDir,
        env,
        logFile: options.logFile,
      },
      {
        cmd: "bunx",
        args: [
          "vite",
          "dev",
          "--port",
          String(options.cloudPort),
          "--strictPort",
          "--host",
          options.host ?? "127.0.0.1",
        ],
        cwd: cloudDir,
        env,
        logFile: options.logFile,
      },
    ],
    { label: "cloud" },
  );

  const teardown = async () => {
    await procs.teardown();
    await workos.close();
    await autumn.close();
  };

  try {
    const local = `http://127.0.0.1:${options.cloudPort}`;
    await waitForHttp(local);
    // The API plane is ready when login actually redirects to AuthKit.
    await waitForHttp(`${local}/api/auth/login`, { expectRedirect: true });
  } catch (error) {
    await teardown();
    throw error;
  }
  return { teardown, pids: procs.pids, workosUrl, autumnUrl: autumn.url };
};
