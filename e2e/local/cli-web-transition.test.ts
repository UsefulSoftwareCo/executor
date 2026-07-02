// Local CLI: `executor web` used to mean "start a foreground server". The
// first-time CLI setup path is now explicit: install the durable background
// service first, then use `executor web` to open it. A fresh `web` invocation
// should guide the user without minting local-server credentials/manifest state
// or binding ports.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

scenario(
  "CLI web · a fresh install points users at setup instead of starting a foreground server",
  { timeout: 120_000 },
  Effect.promise(async () => {
    const root = mkdtempSync(join(tmpdir(), "executor-web-transition-"));
    const dataDir = join(root, "data");
    try {
      const { stdout, stderr } = await execFileAsync("bun", ["run", "dev:cli", "web"], {
        cwd: repoRoot,
        env: { ...process.env, EXECUTOR_DATA_DIR: dataDir },
      });
      const output = `${stdout}\n${stderr}`;

      expect(output, "plain web should not start the old foreground server").not.toContain("Open:");
      expect(output, "plain web should explain that no service is running").toContain(
        "Executor is not running.",
      );
      expect(output, "plain web should direct first-time users to durable setup").toContain(
        "install",
      );
      expect(
        output,
        "plain web should keep the temporary-server escape hatch discoverable",
      ).toContain("web --foreground");
      expect(
        existsSync(join(dataDir, "server-control", "auth.json")),
        "plain web should not mint a local auth token",
      ).toBe(false);
      expect(
        existsSync(join(dataDir, "server-control", "server.json")),
        "plain web should not write a foreground server manifest",
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }),
);

scenario(
  "CLI web · --scope without --foreground warns instead of silently ignoring it",
  { timeout: 120_000 },
  Effect.promise(async () => {
    // Regression guard for "Had to setup my config again": `executor web --scope X`
    // without `--foreground` cannot honor the scope (it opens the running service,
    // which keeps its own scope). That used to be a SILENT no-op — the user lands
    // on a different workspace and thinks their config vanished. It must warn.
    const root = mkdtempSync(join(tmpdir(), "executor-web-scope-"));
    const dataDir = join(root, "data");
    const scopeDir = join(root, "workspace");
    try {
      const { stdout, stderr } = await execFileAsync(
        "bun",
        ["run", "dev:cli", "web", "--scope", scopeDir],
        { cwd: repoRoot, env: { ...process.env, EXECUTOR_DATA_DIR: dataDir } },
      );
      const output = `${stdout}\n${stderr}`;

      expect(output, "the dropped --scope is called out, not silently ignored").toContain(
        "Ignoring --scope",
      );
      expect(output, "the warning names the scope it dropped").toContain(scopeDir);
      expect(output, "the warning points at the flag that actually applies scope").toContain(
        "--foreground",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }),
);
