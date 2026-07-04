import { describe, expect, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../../..");

const runOxlint = (files: readonly string[]) =>
  spawnSync(
    join(repoRoot, "node_modules", ".bin", "oxlint"),
    ["-c", join(repoRoot, ".oxlintrc.jsonc"), ...files, "--deny-warnings"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

const runOxlintOn = async (name: string, source: string) => {
  const dir = join(repoRoot, ".local", "oxlint-plugin-executor-tests");
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, source);

  const result = runOxlint([file]);

  await rm(file, { force: true });
  return result;
};

const runOxlintFile = (repoRelativeFile: string) => runOxlint([join(repoRoot, repoRelativeFile)]);

describe("executor oxlint plugin", () => {
  it("rejects expect calls in conditional test branches", async () => {
    const result = await runOxlintOn(
      "conditional-expect.test.ts",
      `
        import { describe, expect, it } from "@effect/vitest";

        const helper = (value: string | undefined) => {
          if (value) {
            expect(value).toBe("ok");
          }
        };

        describe("example", () => {
          it("uses a helper", () => {
            helper("ok");
          });
        });
      `,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("executor(no-conditional-tests)");
  });

  it("allows unconditional expects over conditional values", async () => {
    const result = await runOxlintOn(
      "unconditional-expect.test.ts",
      `
        import { describe, expect, it } from "@effect/vitest";

        const pick = (flag: boolean) => flag ? "ok" : "no";

        describe("example", () => {
          it("compares the selected value", () => {
            const value = pick(true);
            expect(value).toBe("ok");
          });
        });
      `,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Found 0 warnings and 0 errors.");
    expect(result.stderr).toBe("");
  });

  it("rejects Schema.Class declarations anywhere", async () => {
    const result = await runOxlintOn(
      "schema-class.ts",
      `
        import { Schema } from "effect";

        export class Thing extends Schema.Class<Thing>("Thing")({
          name: Schema.String,
        }) {}
      `,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("executor(no-schema-class)");
  });

  it("rejects Schema.TaggedClass declarations anywhere", async () => {
    const result = await runOxlintOn(
      "schema-tagged-class.ts",
      `
        import { Schema } from "effect";

        export class Thing extends Schema.TaggedClass<Thing>()("Thing", {
          name: Schema.String,
        }) {}
      `,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("executor(no-schema-class)");
  });

  it("allows Schema.TaggedErrorClass (typed errors are exempt)", async () => {
    const result = await runOxlintOn(
      "tagged-error.ts",
      `
        import { Schema } from "effect";

        export class MyError extends Schema.TaggedErrorClass<MyError>()("MyError", {
          message: Schema.String,
        }) {}
      `,
    );

    expect(result.status).toBe(0);
  });

  it("allows structural HTTP payload schemas", async () => {
    const result = await runOxlintOn(
      "struct-payload.ts",
      `
        import { HttpApiEndpoint } from "effect/unstable/httpapi";
        import { Schema } from "effect";

        const CreateThing = Schema.Struct({
          name: Schema.String,
        });

        HttpApiEndpoint.post("createThing", "/things", {
          payload: CreateThing,
        });
      `,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Found 0 warnings and 0 errors.");
    expect(result.stderr).toBe("");
  });

  it("allows typed error messages in Effect.catchTag handlers", async () => {
    const result = await runOxlintOn(
      "catch-tag-message.ts",
      `
        import { Effect } from "effect";

        declare const program: Effect.Effect<string, { _tag: "DomainError"; message: string }>;

        export const handled = program.pipe(
          Effect.catchTag("DomainError", (err) => Effect.succeed(err.message)),
        );
      `,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Found 0 warnings and 0 errors.");
  });

  it("rejects unknown error messages outside Effect.catchTag handlers", async () => {
    const result = await runOxlintOn(
      "unknown-message.ts",
      `
        export const format = (err: unknown) => String((err as { message: string }).message);
      `,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("executor(no-unknown-error-message)");
  });

  it("rejects hand-rolled null predicates in Effect files", async () => {
    const result = await runOxlintOn(
      "manual-null-predicate.ts",
      `
        import { Effect } from "effect";

        const isNonNull = <A>(value: A | null): value is A => value !== null;

        export const values = [Effect.void, null].filter(isNonNull);
      `,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("executor(prefer-effect-predicate)");
  });

  it("rejects inline nullish filter predicates in Effect files", async () => {
    const result = await runOxlintOn(
      "inline-nullish-filter.ts",
      `
        import { Predicate } from "effect";

        export const values = ["ok", null].filter((value): value is string => value !== null);
      `,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("executor(prefer-effect-predicate)");
  });

  it("allows null filters in files that do not import Effect", async () => {
    const result = await runOxlintOn(
      "plain-null-filter.ts",
      `
        export const values = ["ok", null].filter((value): value is string => value !== null);
      `,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Found 0 warnings and 0 errors.");
  });

  it("rejects raw Durable Object id resolution", async () => {
    const result = await runOxlintOn(
      "raw-durable-object-id.ts",
      `
        declare const namespace: {
          readonly idFromName: (name: string) => unknown;
          readonly idFromString: (id: string) => unknown;
        };

        namespace.idFromName("session");
        namespace.idFromString("session");
      `,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("executor(no-raw-durable-object-id)");
    expect(result.stdout).toContain("Use the canonical helper");
  });

  it("allows canonical Durable Object helper files to resolve ids", () => {
    const result = runOxlintFile("packages/hosts/cloudflare/src/mcp/session-stub.ts");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Found 0 warnings and 0 errors.");
  });
});
