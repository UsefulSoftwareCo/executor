import { describe, expect, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWrapperEntrypoints } from "../wrapper-entrypoints";

describe("wrapper entrypoints", () => {
  it("keeps the legacy bin/executor path working alongside bin.mjs", async () => {
    const wrapperDir = await mkdtemp(join(tmpdir(), "executor-wrapper-entrypoints-"));

    try {
      await writeWrapperEntrypoints(
        wrapperDir,
        'process.stdout.write(process.argv.slice(2).join(" "));',
      );

      for (const entrypoint of [join(wrapperDir, "bin.mjs"), join(wrapperDir, "bin", "executor")]) {
        const result = spawnSync(process.execPath, [entrypoint, "--version"], {
          encoding: "utf8",
        });

        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("--version");
      }
    } finally {
      await rm(wrapperDir, { recursive: true, force: true });
    }
  });
});
