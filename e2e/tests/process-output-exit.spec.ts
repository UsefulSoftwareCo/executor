/**
 * The CLI's output at exit (`apps/local/server/src/implementation/process-output.ts`) must not hold
 * the process open when stderr is a pipe nobody reads. Its last line (`processOutput.last`) is
 * written after every other line, and the exit then waits for stderr at most `signalDrainMs`. The
 * local server's exit line once waited there for a reader that never came, on Windows, and on
 * Linux and macOS when the process had never opened its stderr stream.
 *
 * A driver gives a child a stderr pipe whose read end another process holds and never reads, after
 * a third process has filled it. The child loads the CLI's output module, sets a last line and runs
 * its teardown for a command that ended normally, with no signal: the case only the last line's
 * own bound covers.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** The child: the CLI's output, a last line, and runMain's teardown for a command that succeeded. */
const child = [
  'const { processOutput } = await import("./apps/local/server/src/implementation/process-output.ts");',
  'const { Exit } = await import("effect");',
  'processOutput.last(() => "x");',
  "processOutput.teardown(Exit.void, (code) => process.exit(code));",
].join("\n");

/**
 * Fills a pipe nobody reads, starts the child with it as stderr and reports how the child ended:
 * its exit, or a kill at `limit` milliseconds.
 */
const driver = `
const { spawn } = await import("node:child_process");
const limit = Number(process.env.LIMIT_MS);
const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: ["pipe", "ignore", "ignore"] });
const filler = spawn(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(1 << 20))"], { stdio: ["ignore", holder.stdin, "ignore"] });
filler.on("spawn", () => setTimeout(() => {
  const started = performance.now();
  const full = filler.exitCode === null && filler.signalCode === null;
  const child = spawn(process.execPath, ["--input-type=module", "-e", process.env.CHILD], { stdio: ["ignore", "ignore", holder.stdin] });
  const kill = setTimeout(() => child.kill("SIGKILL"), limit);
  child.on("exit", (code, signal) => {
    clearTimeout(kill);
    process.stdout.write(JSON.stringify({ code, signal, full, milliseconds: performance.now() - started }));
    holder.kill("SIGKILL");
    filler.kill("SIGKILL");
  });
}, 300));
`;

const Ended = Schema.fromJsonString(
  Schema.Struct({
    code: Schema.NullOr(Schema.Number),
    signal: Schema.NullOr(Schema.String),
    full: Schema.Boolean,
    milliseconds: Schema.Number,
  }),
);

layer(NodeServices.layer)("CLI output at exit", (it) => {
  it.effect("a command whose last line meets a full stderr pipe nobody reads still exits", () =>
    Effect.gen(function* () {
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const run = yield* processes.spawn(
        ChildProcess.make(process.execPath, ["--input-type=module", "-e", driver], {
          extendEnv: true,
          env: { CHILD: child, LIMIT_MS: "10000" },
        }),
      );
      const [output, exitCode] = yield* Effect.all(
        [run.all.pipe(Stream.decodeText(), Stream.mkString), run.exitCode],
        { concurrency: "unbounded" },
      );
      expect(Number(exitCode), output).toBe(0);
      const ended = yield* Schema.decodeUnknownEffect(Ended)(output);
      // The pipe was still full when the child started, so its last line could not be written.
      expect(ended.full).toBe(true);
      expect(ended.signal, output).toBeNull();
      expect(ended.code).toBe(0);
      expect(ended.milliseconds).toBeLessThan(2_000);
    }).pipe(Effect.scoped),
  );
});
