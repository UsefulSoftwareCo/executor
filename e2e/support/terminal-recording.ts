import { resolveTerminalControlBinary } from "@kitlangton/terminal-control";
import { Effect, FileSystem, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const terminalCaptureType = "application/x-terminal-control";
const Event = Schema.Struct({ type: Schema.String, at_ms: Schema.optional(Schema.Number) });

export const firstTerminalOutput = (source: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lines = (yield* fs.readFileString(source)).trim().split("\n");
    const events = yield* Effect.forEach(lines, (line) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(Event))(line),
    ).pipe(Effect.mapError(() => new Error("Cannot decode terminal capture timestamps")));
    const firstOutput = events.find((event) => event.type === "output");
    if (firstOutput && firstOutput.at_ms === undefined)
      return yield* Effect.die(new Error("Terminal output is missing its timestamp"));
    return firstOutput?.at_ms ?? null;
  });

export const renderTerminalRecording = (source: string) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    if (!source.endsWith(".termctrl"))
      return yield* Effect.die(new Error("Expected a Terminal Control capture"));
    const output = `${source.slice(0, -".termctrl".length)}.mp4`;
    const code = yield* processes.exitCode(
      ChildProcess.make(
        resolveTerminalControlBinary(),
        ["video", source, "--include-startup", "--tail-ms", "1000", "--out", output],
        { stdout: "ignore", stderr: "pipe", forceKillAfter: "5 seconds" },
      ),
    );
    if (code !== 0) return yield* Effect.die(new Error("Terminal recording export failed"));
  });
