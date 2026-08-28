import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestBin = resolve(appRoot, "../../node_modules/vitest/vitest.mjs");
const fixtureConfig = resolve(appRoot, "test-fixtures/test-globalsetup-exit/vitest.config.ts");

const runFixture = (port: number, shouldPass: boolean) =>
  spawnSync(process.execPath, [vitestBin, "run", "--config", fixtureConfig], {
    cwd: appRoot,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      CLOUD_TEST_DB_PORT: String(port),
      TEST_GLOBALSETUP_SHOULD_PASS: String(shouldPass),
    },
  });

const diagnostic = (result: ReturnType<typeof runFixture>): string =>
  [result.stdout, result.stderr].filter(Boolean).join("\n");

describe("cloud test global setup", () => {
  it("does not let PGlite teardown turn a passed test red", { timeout: 60_000 }, () => {
    const result = runFixture(45_435, true);

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, diagnostic(result)).toBe(0);
  });

  it("does not let PGlite teardown turn a failed test green", { timeout: 60_000 }, () => {
    const result = runFixture(45_436, false);

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, diagnostic(result)).toBe(1);
  });
});
