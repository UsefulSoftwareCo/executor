/** Terminal capture analysis and video export run after all test processes have exited. */
import { resolveTerminalControlBinary } from "@kitlangton/terminal-control";
import { Effect, FileSystem, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/** A raw Terminal Control capture, distinct from a rendered video. */
export const terminalCaptureType = "application/x-terminal-control";
const Event = Schema.Struct({ type: Schema.String, at_ms: Schema.optional(Schema.Number) });

/** Read the first output timestamp without exposing recorded terminal content in errors. */
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

/** Export the full source timeline; focus composition trims it later without changing test timing. */
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
