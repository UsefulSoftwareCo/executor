// Local CLI: `executor open` must not trust a live pid in server.json until it
// has proven the recorded endpoint is actually the running Executor server.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import {
  normalizeExecutorServerConnection,
  serializeExecutorLocalServerManifest,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

const openerName = (): string =>
  process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";

scenario(
  "CLI open · a stale manifest cannot print or open the saved bearer URL",
  { timeout: 120_000 },
  Effect.promise(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "executor-open-stale-"));
    const openerDir = mkdtempSync(join(tmpdir(), "executor-open-shim-"));
    try {
      const port = await freePort();
      const token = `stale-token-${randomBytes(4).toString("hex")}`;
      mkdirSync(join(dataDir, "server-control"), { recursive: true });
      writeFileSync(
        join(dataDir, "server-control", "server.json"),
        serializeExecutorLocalServerManifest({
          version: 1,
          kind: "foreground",
          pid: process.pid,
          startedAt: new Date().toISOString(),
          dataDir,
          scopeDir: dataDir,
          connection: normalizeExecutorServerConnection({
            origin: `http://127.0.0.1:${port}`,
            displayName: "Stale test server",
            auth: { kind: "bearer", token },
          }),
          owner: { client: "cli", version: null, executablePath: null },
        }),
        { mode: 0o600 },
      );

      const openerPath = join(openerDir, openerName());
      writeFileSync(openerPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      chmodSync(openerPath, 0o755);

      const { stdout, stderr } = await execFileAsync("bun", ["run", "dev:cli", "open"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          EXECUTOR_DATA_DIR: dataDir,
          PATH: `${openerDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      });
      const output = `${stdout}\n${stderr}`;
      expect(output, "stale endpoint should be rejected before printing the token URL").toContain(
        "Executor is not running.",
      );
      expect(output, "the recovery path should point users at durable setup").toContain("install");
      expect(output, "the old foreground behavior should remain discoverable").toContain(
        "web --foreground",
      );
      expect(output, "the stale bearer must not be printed").not.toContain(token);
      expect(output, "the stale URL must not be opened").not.toContain(`127.0.0.1:${port}`);
    } finally {
      rmSync(openerDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  }),
);
