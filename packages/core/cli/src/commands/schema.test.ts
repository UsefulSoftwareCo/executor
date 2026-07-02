import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { schema } from "./schema";

describe("schema generate", () => {
  it.effect("generates a FumaDB-backed Drizzle schema from executor config", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "executor-cli-schema-"))),
      (cwd) =>
        Effect.promise(async () => {
          await writeFile(
            join(cwd, "executor.config.js"),
            "export default { plugins: () => [] };\n",
          );

          await schema.parseAsync(
            [
              "node",
              "test",
              "generate",
              "--cwd",
              cwd,
              "--output",
              "generated/executor-schema.ts",
              "--namespace",
              "executor_cli_test",
              "--provider",
              "sqlite",
            ],
            { from: "node" },
          );

          const generated = await readFile(join(cwd, "generated/executor-schema.ts"), "utf8");
          expect(generated).toContain("executor_cli_test");
          expect(generated).toContain("integration");
          expect(generated).toContain("connection");
        }),
      (cwd) => Effect.promise(() => rm(cwd, { recursive: true, force: true })),
    ),
  );
});
