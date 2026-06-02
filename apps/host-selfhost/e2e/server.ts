// ---------------------------------------------------------------------------
// Boots host-selfhost FULLY ASSEMBLED for the Playwright e2e suite.
//
// This runs the real production server (`bun run src/serve.ts`) — the same
// artifact that ships — serving the built SPA + the typed Effect API + Better
// Auth + MCP from one Bun process, against a FRESH throwaway data dir so every
// run starts at the zero-config first-run state (`needsSetup: true`).
//
// Hermetic by construction: Better Auth + libSQL are in-process, so there are
// no external services, no secrets, nothing to stub. That's the whole point —
// the bugs we care about live in the *assembly*, and this boots the real
// assembly end to end. Used by playwright.config.ts's `webServer`.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.E2E_PORT ?? "4796";
const ORIGIN = `http://localhost:${PORT}`;

// A fresh data dir per boot guarantees the turnkey first-run: the seeded org has
// zero members, so the app shows the setup form. Removed on exit.
const dataDir = mkdtempSync(join(tmpdir(), "executor-selfhost-e2e-"));

const child = spawn("bun", ["run", "src/serve.ts"], {
  cwd: appDir,
  stdio: "inherit",
  env: {
    ...process.env,
    EXECUTOR_DATA_DIR: dataDir,
    PORT,
    EXECUTOR_WEB_BASE_URL: ORIGIN,
    BETTER_AUTH_SECRET: "e2e_selfhost_secret_0123456789abcdef",
    EXECUTOR_ORG_NAME: "E2E Test Org",
    // EXECUTOR_BOOTSTRAP_ADMIN_* intentionally unset → turnkey setup-form path.
  },
});

const removeDataDir = () => rmSync(dataDir, { recursive: true, force: true });

child.on("exit", (code) => {
  removeDataDir();
  process.exit(code ?? 0);
});
process.on("SIGINT", () => {
  child.kill("SIGTERM");
  removeDataDir();
  process.exit(0);
});
process.on("SIGTERM", () => {
  child.kill("SIGTERM");
  removeDataDir();
  process.exit(0);
});
