/**
 * The `apps-version` job runs `scripts/releases/apps-bumped.ts` to require a new `apps` version
 * whenever a pull request changes what the package publishes. These cases run it as a process on
 * staged packages written beforehand (main's, the pull request's, and where the pull request meets
 * main) the way the job does: once against main, and when it exits 3, again with the merge base.
 * They read its exit codes and output.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** One staged package: its version and the content of its one module. */
interface Staged {
  readonly version: string;
  readonly code: string;
}

/**
 * `base` is main's tip and `mergeBase` where the pull request meets main: main's tip for a pull
 * request into main (the default), an older main for an upper stack layer.
 */
const check = (input: {
  readonly base: Staged;
  readonly head: Staged;
  readonly mergeBase?: Staged;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-apps-bumped-" });
    const stage = (target: string, staged: Staged) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(target, { recursive: true });
        yield* fs.writeFileString(
          path.join(target, "package.json"),
          JSON.stringify({ name: "apps", version: staged.version, main: "index.js" }),
        );
        yield* fs.writeFileString(path.join(target, "index.js"), staged.code);
      });
    // The script reads the pull request's package from packages/apps/dist under its directory.
    yield* stage(path.join(directory, "packages/apps/dist"), input.head);
    yield* stage(path.join(directory, "base"), input.base);
    yield* stage(path.join(directory, "merge-base"), input.mergeBase ?? input.base);
    const run = (directories: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const child = yield* processes.spawn(
          ChildProcess.make(
            "node",
            [
              path.resolve("scripts/releases/apps-bumped.ts"),
              ...directories.map((name) => path.join(directory, name)),
            ],
            { cwd: directory },
          ),
        );
        const [log, exitCode] = yield* Effect.all(
          [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
          { concurrency: "unbounded" },
        );
        return { exitCode, log };
      }).pipe(Effect.scoped);
    const first = yield* run(["base"]);
    if (first.exitCode !== 3) return { ...first, askedForMergeBase: false };
    const second = yield* run(["base", "merge-base"]);
    return { ...second, log: `${first.log}${second.log}`, askedForMergeBase: true };
  }).pipe(Effect.scoped);

const base = { version: "0.0.1-beta.136", code: "export const answer = 1;\n" };
const changed = "export const answer = 2;\n";

layer(NodeServices.layer, { excludeTestServices: true })("Apps version bump", (it) => {
  it.effect("an unchanged package keeps its version", () =>
    Effect.gen(function* () {
      const result = yield* check({ base, head: base });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.log).toContain("unchanged from the base (0.0.1-beta.136)");
    }),
  );

  it.effect("a changed package that keeps its version fails and names the next one", () =>
    Effect.gen(function* () {
      const result = yield* check({ base, head: { ...base, code: changed } });
      expect(result.exitCode, result.log).toBe(1);
      expect(result.log).toContain(
        "packages/apps changed from the base but keeps apps@0.0.1-beta.136; bump the version in packages/apps/package.json to 0.0.1-beta.137 or later",
      );
    }),
  );

  it.effect("a changed package with a greater version passes", () =>
    Effect.gen(function* () {
      const result = yield* check({
        base,
        head: { version: "0.0.1-beta.137", code: changed },
      });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.log).toContain("moves from 0.0.1-beta.136 to 0.0.1-beta.137");
    }),
  );

  it.effect("a changed package whose version moves back fails, even to an unused number", () =>
    Effect.gen(function* () {
      // beta.131 differs from main's beta.136 but is lower, like a number a skipped deploy never
      // published.
      const result = yield* check({
        base,
        head: { version: "0.0.1-beta.131", code: changed },
      });
      expect(result.exitCode, result.log).toBe(1);
      expect(result.log).toContain(
        "its version moves back from 0.0.1-beta.136 on the base to 0.0.1-beta.131; take 0.0.1-beta.137 or later",
      );
    }),
  );

  it.effect("numbers compare as numbers, not as text", () =>
    Effect.gen(function* () {
      const result = yield* check({
        base: { ...base, version: "0.0.1-beta.99" },
        head: { version: "0.0.1-beta.100", code: changed },
      });
      expect(result.exitCode, result.log).toBe(0);
    }),
  );

  it.effect("a stack layer behind a bump on main that does not change apps passes", () =>
    Effect.gen(function* () {
      // Main moved to beta.137 after the stack branched from beta.136; the stack never touched apps.
      const result = yield* check({
        base: { version: "0.0.1-beta.137", code: changed },
        head: base,
        mergeBase: base,
      });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.askedForMergeBase).toBe(true);
      expect(result.log).toContain(
        "This pull request does not change the apps package; it is behind main's 0.0.1-beta.137",
      );
    }),
  );

  it.effect(
    "a change to apps that keeps a number at or below main's fails and names the next",
    () =>
      Effect.gen(function* () {
        const other = "export const answer = 3;\n";
        const kept = yield* check({
          base: { version: "0.0.1-beta.137", code: changed },
          head: { version: "0.0.1-beta.137", code: other },
          mergeBase: base,
        });
        expect(kept.exitCode, kept.log).toBe(1);
        expect(kept.log).toContain(
          "keeps apps@0.0.1-beta.137; bump the version in packages/apps/package.json to 0.0.1-beta.138 or later",
        );
        const below = yield* check({
          base: { version: "0.0.1-beta.137", code: changed },
          head: { version: "0.0.1-beta.136", code: other },
          mergeBase: base,
        });
        expect(below.exitCode, below.log).toBe(1);
        expect(below.log).toContain(
          "moves back from 0.0.1-beta.137 on the base to 0.0.1-beta.136; take 0.0.1-beta.138 or later",
        );
      }),
  );

  it.effect(
    "a stack that changes apps behind a bump must go above main's tip, not its merge base's",
    () =>
      Effect.gen(function* () {
        // The stack bumped beta.136 to beta.137 from its merge base, but main has since taken beta.137.
        const result = yield* check({
          base: { version: "0.0.1-beta.137", code: changed },
          head: { version: "0.0.1-beta.137", code: "export const answer = 3;\n" },
          mergeBase: base,
        });
        expect(result.exitCode, result.log).toBe(1);
        expect(result.log).toContain("to 0.0.1-beta.138 or later");
      }),
  );
});
