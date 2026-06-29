// One-off: boot a cloud stack (emulators + dev-db + vite) for ad-hoc
// recording, outside vitest. Same wiring as setup/cloud.globalsetup.ts.
//
// Usage: bun e2e/scripts/boot-stack.ts <cloud-app-dir> <port>
//   (emulators take port+1/+2, dev-db port+3; Ctrl-C tears down)
import { rmSync } from "node:fs";
import { resolve } from "node:path";

import { createEmulator } from "@executor-js/emulate";

import { bootProcesses, waitForHttp } from "../setup/boot";

const [cloudDirArg, portArg] = process.argv.slice(2);
if (!cloudDirArg || !portArg) {
  console.error("usage: bun e2e/scripts/boot-stack.ts <cloud-app-dir> <port>");
  process.exit(1);
}
const cloudDir = resolve(cloudDirArg);
const port = Number(portArg);
const baseUrl = `http://127.0.0.1:${port}`;

const workos = await createEmulator({ service: "workos", port: port + 1 });
const autumn = await createEmulator({ service: "autumn", port: port + 2 });

const dbPath = resolve(cloudDir, ".e2e-record-db");
rmSync(dbPath, { recursive: true, force: true });

const env = {
  WORKOS_API_URL: workos.url,
  AUTUMN_API_URL: autumn.url,
  WORKOS_API_KEY: "sk_test_emulate",
  WORKOS_CLIENT_ID: "client_e2e_emulate",
  WORKOS_COOKIE_PASSWORD: "e2e_cookie_password_0123456789abcdef0123456789abcdef",
  AUTUMN_SECRET_KEY: "am_test_emulate",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port + 3}/postgres`,
  EXECUTOR_DIRECT_DATABASE_URL: "true",
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
  VITE_PUBLIC_SITE_URL: baseUrl,
  MCP_AUTHKIT_DOMAIN: workos.url,
  MCP_RESOURCE_ORIGIN: baseUrl,
  ALLOW_LOCAL_NETWORK: "true",
  DEV_DB_PORT: String(port + 3),
  DEV_DB_PATH: dbPath,
};

const procs = bootProcesses(
  [
    { cmd: "bun", args: ["run", "scripts/dev-db.ts"], cwd: cloudDir, env },
    {
      cmd: "bunx",
      args: ["vite", "dev", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
      cwd: cloudDir,
      env,
    },
  ],
  { label: "record-stack" },
);

await waitForHttp(baseUrl);
await waitForHttp(`${baseUrl}/api/auth/login`, { expectRedirect: true });
console.log(`ready: ${baseUrl}`);

const teardown = async () => {
  await procs.teardown();
  await workos.close();
  await autumn.close();
  process.exit(0);
};
process.on("SIGINT", () => void teardown());
process.on("SIGTERM", () => void teardown());
