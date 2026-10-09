import { Stream } from "effect";
import type { ChildProcessSpawner } from "effect/process";

/**
 * Every line a child prints, whole. Each pipe is decoded and split on its own before the two are
 * merged: merging the bytes first would splice a line written in pieces to one pipe with whatever
 * the other pipe wrote in between.
 */
export const outputLines = (child: ChildProcessSpawner.ChildProcessHandle) =>
  Stream.merge(
    child.stdout.pipe(Stream.decodeText(), Stream.splitLines),
    child.stderr.pipe(Stream.decodeText(), Stream.splitLines),
  );

/**
 * How `alchemy dev` starts the line it prints when it gives up on an apply or a whole run
 * (`describeFailure` in alchemy's src/Cli/exec.ts): either step failed, or it ended with nothing
 * but interruptions. Either way dev keeps running and retries only after a source file changes,
 * which never happens in a run.
 */
const alchemyDevFailures = [
  "alchemy dev: apply failed;",
  "alchemy dev: apply was interrupted internally",
  "alchemy dev: run failed;",
  "alchemy dev: run was interrupted internally",
];

/** Whether `line` is `alchemy dev` reporting that it gave up on starting a resource. */
export const isAlchemyDevFailure = (line: string) =>
  alchemyDevFailures.some((prefix) => line.startsWith(prefix));
