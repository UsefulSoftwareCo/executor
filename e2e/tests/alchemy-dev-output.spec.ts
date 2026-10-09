/**
 * A managed local Cloud writes `alchemy dev`'s stdout and stderr to cloud.log line by line, and its
 * readiness wait fails as soon as alchemy prints that it gave up on starting a resource
 * (e2e/support/cloud-environment.ts). These cases run a child that writes lines in pieces to both
 * pipes, and check the lines and failures the harness reads from it.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { isAlchemyDevFailure, outputLines } from "../support/alchemy-dev-output.ts";

const applyFailed =
  "alchemy dev: apply failed; keeping dev alive so healthy resources keep serving.";
const applyInterrupted =
  "alchemy dev: apply was interrupted internally (a bug in a provider or the engine — please report it with the trace below); keeping dev alive so healthy resources keep serving.";
const runFailed = "alchemy dev: run failed; waiting for the next file change to retry.";
const runInterrupted =
  "alchemy dev: run was interrupted internally (a bug in a provider or the engine — please report it with the trace below); waiting for the next file change to retry.";

/**
 * Writes each piece after the one before has left the process, alternating pipes mid-line. The
 * interrupted message is cut inside the UTF-8 bytes of its dash.
 */
const writer = `
const pieces = JSON.parse(process.argv[1]);
for (const [pipe, base64] of pieces) {
  await new Promise((resolve) => process[pipe].write(Buffer.from(base64, "base64"), resolve));
  await new Promise((resolve) => setTimeout(resolve, 30));
}
`;

const interrupted = Buffer.from(`${applyInterrupted}\n`);
const dash = interrupted.indexOf(Buffer.from("—")) + 1;
const pieces: ReadonlyArray<readonly ["stdout" | "stderr", Buffer]> = [
  ["stderr", Buffer.from("alchemy dev: apply f")],
  ["stdout", Buffer.from("Site build ")],
  ["stderr", Buffer.from(applyFailed.slice("alchemy dev: apply f".length) + "\nError: synth")],
  ["stdout", Buffer.from("progress\n[Dashboard] crea")],
  ["stderr", Buffer.from("etic failure\n")],
  ["stderr", interrupted.subarray(0, dash)],
  ["stdout", Buffer.from("ting\n")],
  ["stderr", interrupted.subarray(dash)],
  ["stdout", Buffer.from("last line without a newline")],
];

layer(NodeServices.layer, { excludeTestServices: true })("alchemy dev output", (it) => {
  it.effect("lines written in pieces to both pipes reach the harness whole", () =>
    Effect.gen(function* () {
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* processes.spawn(
        ChildProcess.make("node", [
          "--input-type=module",
          "--eval",
          writer,
          JSON.stringify(pieces.map(([pipe, bytes]) => [pipe, bytes.toString("base64")])),
        ]),
      );
      const lines = Array.from(yield* Stream.runCollect(outputLines(child)));
      expect(yield* child.exitCode).toBe(0);
      expect(lines.toSorted()).toEqual(
        [
          applyFailed,
          "Error: synthetic failure",
          applyInterrupted,
          "Site build progress",
          "[Dashboard] creating",
          "last line without a newline",
        ].toSorted(),
      );
      expect(lines.filter(isAlchemyDevFailure)).toEqual([applyFailed, applyInterrupted]);
    }).pipe(Effect.scoped),
  );

  it.effect("each way alchemy dev reports giving up is a failure, and nothing else is", () =>
    Effect.sync(() => {
      for (const line of [applyFailed, applyInterrupted, runFailed, runInterrupted]) {
        expect(isAlchemyDevFailure(line), line).toBe(true);
      }
      for (const line of [
        "Port 1337 is in use, serving on 1338",
        "[Dashboard] creating",
        "BuildMessage: Unexpected <<",
        `  quoted: ${applyFailed}`,
      ]) {
        expect(isAlchemyDevFailure(line), line).toBe(false);
      }
    }),
  );
});
