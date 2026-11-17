/**
 * `bun run check` fails on a tracked file that still holds a merge conflict's markers
 * (scripts/check-conflict-markers.ts). These cases run the check on this checkout, which must pass,
 * and in a new repository with a conflict left in one tracked file, which must fail and name each
 * marker's file and line. The markers are built here at run time, so this file holds none.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const [ours, base, middle, theirs] = ["<", "|", "=", ">"].map((mark) => mark.repeat(7));

/** Run a command in `cwd` and return its exit code and everything it printed. */
const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make(command, args, { cwd, extendEnv: true }),
    );
    const [output, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { exitCode: Number(exitCode), output };
  }).pipe(Effect.scoped);

const check = (cwd: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* run("node", [path.resolve("scripts/check-conflict-markers.ts")], cwd);
  });

layer(NodeServices.layer)("Leftover conflict markers", (it) => {
  it.effect("this checkout's tracked files hold none", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const result = yield* check(path.resolve("."));
      expect(result.output).toContain("No conflict markers in tracked files.");
      expect(result.exitCode, result.output).toBe(0);
    }),
  );

  it.effect("a conflict left in a tracked file fails, naming each marker's file and line", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const repository = yield* fs.makeTempDirectoryScoped({ prefix: "executor-markers-" });
      yield* fs.makeDirectory(path.join(repository, "docs"));
      // A diff3 conflict, as `git merge` leaves it with merge.conflictStyle=diff3.
      yield* fs.writeFileString(
        path.join(repository, "docs/notes.md"),
        [
          "# Notes",
          `${ours} HEAD`,
          "ours",
          `${base} base`,
          "base",
          middle,
          "theirs",
          `${theirs} topic`,
          "",
        ].join("\n"),
      );
      // Lines that only look like markers: a longer rule, a marker run on into text, a quoted one.
      yield* fs.writeFileString(
        path.join(repository, "clean.md"),
        ["Title", `${middle}===`, `${ours}x`, `> ${theirs} topic`, ""].join("\n"),
      );
      // Not tracked, so not checked.
      yield* fs.writeFileString(path.join(repository, "untracked.md"), `${ours} HEAD\n`);
      expect((yield* run("git", ["init", "-q"], repository)).exitCode).toBe(0);
      expect((yield* run("git", ["add", "docs/notes.md", "clean.md"], repository)).exitCode).toBe(
        0,
      );

      const result = yield* check(repository);
      expect(result.exitCode, result.output).toBe(1);
      const named = result.output.split("\n").filter((line) => line.startsWith("  "));
      expect(named).toEqual([
        `  docs/notes.md:2: ${ours} HEAD`,
        `  docs/notes.md:4: ${base} base`,
        `  docs/notes.md:6: ${middle}`,
        `  docs/notes.md:8: ${theirs} topic`,
      ]);
    }).pipe(Effect.scoped),
  );
});
