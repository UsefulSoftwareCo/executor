import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";

import { resolveToolInvocation, sanitizeCliOutputText, shellQuoteArg } from "./tooling";

const withTmp = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "exec-call-"))),
    body,
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );

describe("resolveToolInvocation", () => {
  it.effect("reads the JSON arg from a file via @path", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const file = join(dir, "input.json");
        writeFileSync(file, '{"title":"Hi","n":2}');
        const result = yield* resolveToolInvocation({
          rawPathParts: ["github", "issues", "create", `@${file}`],
        });
        expect(result.path).toBe("github.issues.create");
        expect(result.args).toEqual({ title: "Hi", n: 2 });
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("still accepts inline JSON (slice condition regression)", () =>
    Effect.gen(function* () {
      const result = yield* resolveToolInvocation({
        rawPathParts: ["github", "issues", "create", '{"title":"Hi"}'],
      });
      expect(result.path).toBe("github.issues.create");
      expect(result.args).toEqual({ title: "Hi" });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("treats a path with no trailing JSON as empty args", () =>
    Effect.gen(function* () {
      const result = yield* resolveToolInvocation({ rawPathParts: ["github", "issues", "list"] });
      expect(result.path).toBe("github.issues.list");
      expect(result.args).toEqual({});
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("fails with a path-bearing message when the @file is missing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        resolveToolInvocation({ rawPathParts: ["x", "@/no/such/file.json"] }),
      );
      expect(error.message).toContain("/no/such/file.json");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rejects an @file whose content is not a JSON object", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const file = join(dir, "bad.json");
        writeFileSync(file, "[1,2,3]");
        const error = yield* Effect.flip(
          resolveToolInvocation({ rawPathParts: ["x", `@${file}`] }),
        );
        expect(error.message).toContain("must contain a JSON object");
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rejects a bare '@' with no path", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(resolveToolInvocation({ rawPathParts: ["x", "@"] }));
      expect(error.message).toContain("requires a file path");
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("shellQuoteArg", () => {
  it("quotes single quotes without breaking the shell argument", () => {
    expect(shellQuoteArg(`{"name":"owner's repo"}`)).toBe(`'{"name":"owner'"'"'s repo"}'`);
  });

  it("leaves simple values readable", () => {
    expect(shellQuoteArg("exec_123")).toBe("exec_123");
  });
});

describe("sanitizeCliOutputText", () => {
  it("removes terminal control sequences from tool metadata", () => {
    expect(sanitizeCliOutputText("safe\u001b[2J\u001b]0;title\u0007 text\u0000")).toBe("safe text");
  });

  it("preserves readable multiline content", () => {
    expect(sanitizeCliOutputText("type Input = {\n\tname: string\n}")).toBe(
      "type Input = {\n\tname: string\n}",
    );
  });
});
