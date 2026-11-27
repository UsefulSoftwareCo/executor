import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const child = [
  'const { processOutput } = await import("./apps/local/server/src/implementation/process-output.ts");',
  'const { Exit } = await import("effect");',
  'processOutput.last(() => "x");',
  "processOutput.teardown(Exit.void, (code) => process.exit(code));",
].join("\n");

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
      expect(ended.full).toBe(true);
      expect(ended.signal, output).toBeNull();
      expect(ended.code).toBe(0);
      expect(ended.milliseconds).toBeLessThan(2_000);
    }).pipe(Effect.scoped),
  );
});
