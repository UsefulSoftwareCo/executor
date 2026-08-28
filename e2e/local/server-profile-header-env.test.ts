// Local-only: server profiles can carry HTTP headers backed by environment
// variables. This is the CLI surface needed for Cloudflare Access service
// tokens on self-hosted Executor deployments.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const CLI_ENTRY = "apps/cli/src/main.ts";
const execFileAsync = promisify(execFile);

const runCli = async (
  dataDir: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
): Promise<string> => {
  try {
    const { stdout } = await execFileAsync("bun", ["run", CLI_ENTRY, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        EXECUTOR_DATA_DIR: dataDir,
        EXECUTOR_DISABLE_UPDATE_CHECK: "1",
        ...env,
      },
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
    });
    return stdout;
  } catch (cause) {
    const error = cause as {
      readonly code?: number | string;
      readonly stdout?: string;
      readonly stderr?: string;
    };
    throw new Error(
      `executor ${args.join(" ")} failed with ${error.code ?? "unknown"}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`,
    );
  }
};

scenario(
  "CLI server profiles · header env mappings are persisted without secret values",
  {},
  Effect.promise(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "executor-profile-headers-"));
    try {
      await runCli(dataDir, [
        "server",
        "add",
        "cloudflare",
        "https://executor.example",
        "--header-env",
        "CF-Access-Client-Id=EXECUTOR_CF_ACCESS_CLIENT_ID",
        "--header-env",
        "CF-Access-Client-Secret=EXECUTOR_CF_ACCESS_CLIENT_SECRET",
        "--default",
      ]);

      const listing = await runCli(dataDir, ["server", "list"], {
        EXECUTOR_CF_ACCESS_CLIENT_ID: "dummy-client-id-secret-value",
        EXECUTOR_CF_ACCESS_CLIENT_SECRET: "dummy-client-secret-value",
      });
      expect(listing, "the profile lists its env-backed headers").toContain("2 header-env");
      expect(listing, "listing does not print the client id secret").not.toContain(
        "dummy-client-id-secret-value",
      );
      expect(listing, "listing does not print the client secret").not.toContain(
        "dummy-client-secret-value",
      );

      const raw = readFileSync(join(dataDir, "server-connections.json"), "utf8");
      const store = JSON.parse(raw) as {
        readonly profiles: ReadonlyArray<{
          readonly connection: {
            readonly headers?: Record<string, { readonly kind: string; readonly name: string }>;
          };
        }>;
      };
      expect(store.profiles[0]?.connection.headers).toEqual({
        "CF-Access-Client-Id": {
          kind: "env",
          name: "EXECUTOR_CF_ACCESS_CLIENT_ID",
        },
        "CF-Access-Client-Secret": {
          kind: "env",
          name: "EXECUTOR_CF_ACCESS_CLIENT_SECRET",
        },
      });
      expect(raw, "profile storage keeps env names").toContain("EXECUTOR_CF_ACCESS_CLIENT_ID");
      expect(raw, "profile storage does not keep resolved client id").not.toContain(
        "dummy-client-id-secret-value",
      );
      expect(raw, "profile storage does not keep resolved client secret").not.toContain(
        "dummy-client-secret-value",
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }),
);
