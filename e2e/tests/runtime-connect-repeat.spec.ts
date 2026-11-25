import { expect, layer } from "@effect/vitest";
import { Clock, Duration, Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";

const Attributes = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
);
const Probe = Schema.Struct({
  outcome: Schema.optional(Schema.Literals(["answered", "failed"])),
  failure: Schema.optional(Schema.Unknown),
  connections: Schema.optional(Schema.Number),
  attempts: Schema.optional(Schema.Number),
  invocations: Schema.optional(Schema.Number),
  checks: Schema.optional(Schema.Array(Schema.Number)),
  value: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  decisions: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  wire: Schema.optional(
    Schema.Struct({
      values: Schema.Array(
        Schema.Struct({
          label: Schema.String,
          failure: Schema.optional(Schema.String),
          known: Schema.Boolean,
          notSent: Schema.Boolean,
        }),
      ),
      read: Schema.Array(Schema.Struct({ label: Schema.String, decoded: Schema.Boolean })),
      partlyRunDropsNotSent: Schema.Boolean,
    }),
  ),
  notSent: Schema.optional(Schema.Boolean),
  mayHaveWritten: Schema.optional(Schema.Boolean),
  retryable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  action: Schema.optional(Schema.NullOr(Schema.String)),
  attributes: Attributes,
});

const probeBound = Duration.seconds(20);
const lastOutputChars = 2_000;

class ProbeTimedOut extends Schema.TaggedError<ProbeTimedOut>()("ProbeTimedOut", {
  probe: Schema.String,
  ranMs: Schema.Number,
  boundMs: Schema.Number,
  lastOutput: Schema.String,
}) {
  get message() {
    const output = this.lastOutput.trim();
    return `Probe ${this.probe} ran for ${this.ranMs} ms without finishing (its bound is ${this.boundMs} ms); its last output: ${output === "" ? "(none)" : output}`;
  }
}

const runProbe = (label: string, command: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner,
        evidence = yield* Evidence;
      const started = yield* Clock.currentTimeMillis;
      let stdout = "";
      let last = "";
      const keep = (text: string) => {
        last = (last + text).slice(-lastOutputChars);
      };
      const child = yield* processes.spawn(
        ChildProcess.make(command, [...args], {
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
          extendEnv: false,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runForEach((text) =>
              Effect.sync(() => {
                stdout += text;
                keep(text);
              }),
            ),
          ),
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runForEach((text) => Effect.sync(() => keep(text))),
          ),
        ],
        { concurrency: "unbounded", discard: true },
      ).pipe(
        Effect.timeoutOrElse({
          duration: probeBound,
          orElse: () =>
            Effect.gen(function* () {
              const ranMs = (yield* Clock.currentTimeMillis) - started;
              return yield* new ProbeTimedOut({
                probe: label,
                ranMs,
                boundMs: Duration.toMillis(probeBound),
                lastOutput: last,
              });
            }),
        }),
      );
      yield* evidence.measure(`Probe ${label}`, (yield* Clock.currentTimeMillis) - started);
      return stdout;
    }),
  );

const probe = (runtime: "node" | "bun", name: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const output = yield* runProbe(`${runtime} ${name}`, runtime, [
      "packages/sdk/scripts/runtime-connect-fixture.ts",
      "--case",
      name,
    ]);
    const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Probe))(
      output.trim().split("\n").at(-1) ?? "",
    );
    yield* evidence.json(`runtime-connect-${runtime}-${name}.json`, result);
    return result;
  });

const CallPath = Schema.Struct({
  asked: Schema.optional(Schema.String),
  failure: Schema.Struct({
    tag: Schema.String,
    reason: Schema.String,
    notSent: Schema.Boolean,
    mayHaveWritten: Schema.Boolean,
  }),
  operations: Schema.Array(Schema.String),
});
const callPath = (name: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const output = yield* runProbe(`node call-path ${name}`, "node", [
      "packages/sdk/scripts/call-path-fixture.ts",
      "--case",
      name,
    ]);
    const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CallPath))(
      output.trim().split("\n").at(-1) ?? "",
    );
    yield* evidence.json(`call-path-${name}.json`, result);
    return result;
  });
const notSentSentence =
  "Executor could not connect to the app runtime, so it did not send this tool call.";
const partlyRunSentence =
  "Executor could not reach the app runtime to finish this tool call. An earlier step of the call reached the app, so the call may have partly run.";

const rpc = "executor.runtime.rpc.";
const http = "executor.runtime.http.";

layer(TestLive, { excludeTestServices: true })("Runtime connect repeat", (it) => {
  it.effect(scenarios.runtimeConnectRepeat.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence;
        for (const runtime of ["node", "bun"] as const) {
          yield* evidence.step(
            `${runtime}: an RPC session whose first socket never opened is opened once more and answers`,
            Effect.gen(function* () {
              const rescued = yield* probe(runtime, "rpc-rescued");
              expect(rescued).toMatchObject({ outcome: "answered", connections: 2 });
              expect(rescued.attributes).toMatchObject({
                [`${rpc}connect_attempts`]: 2,
                [`${rpc}first_attempt.error_code`]: "ECONNRESET",
                [`${rpc}connect_outcome`]: "opened",
              });
              expect(typeof rescued.attributes[`${rpc}first_attempt.failed_ms`]).toBe("number");
              expect(
                Object.keys(rescued.attributes).filter(
                  (key) => !key.includes("connect_") && !key.includes("first_attempt."),
                ),
              ).toEqual([]);
            }),
          );

          yield* evidence.step(
            `${runtime}: a real Cap'n Web session whose first socket never opened runs its call once`,
            Effect.gen(function* () {
              const rescued = yield* probe(runtime, "rpc-capnweb-rescued");
              expect(rescued).toMatchObject({
                outcome: "answered",
                value: "ran",
                invocations: 1,
                connections: 2,
              });
              expect(rescued.attributes).toMatchObject({
                [`${rpc}connect_attempts`]: 2,
                [`${rpc}connect_outcome`]: "opened",
                [`${rpc}first_attempt.error_code`]: "ECONNRESET",
              });
              expect(rescued.attributes).not.toHaveProperty(`${rpc}opened`);
              expect(rescued.attributes).not.toHaveProperty(`${rpc}error_code`);
            }),
          );

          yield* evidence.step(
            `${runtime}: an RPC session whose socket never opens twice fails as unreachable, nothing sent`,
            Effect.gen(function* () {
              const unreachable = yield* probe(runtime, "rpc-unreachable");
              expect(unreachable).toMatchObject({
                outcome: "failed",
                failure: { tag: "RuntimeProtocolFailed", reason: "disconnected", notSent: true },
              });
              expect(unreachable.attributes).toMatchObject({
                [`${rpc}connect_attempts`]: 2,
                [`${rpc}first_attempt.error_code`]: "ECONNREFUSED",
                [`${rpc}connect_outcome`]: "failed",
                [`${rpc}opened`]: false,
                [`${rpc}sent`]: 0,
                "executor.runtime.failure": "unreachable",
              });
              const neverOpens = yield* probe(runtime, "rpc-never-opens");
              expect(neverOpens).toMatchObject({
                outcome: "failed",
                connections: 2,
                failure: { tag: "RuntimeProtocolFailed", reason: "disconnected", notSent: true },
              });
              expect(neverOpens.attributes).toMatchObject({
                [`${rpc}connect_attempts`]: 2,
                [`${rpc}first_attempt.error_code`]: "ECONNRESET",
                [`${rpc}connect_outcome`]: "failed",
              });
            }),
          );

          yield* evidence.step(
            `${runtime}: an RPC session that opened is never repeated, whether or not it sent`,
            Effect.gen(function* () {
              for (const [name, sent] of [
                ["rpc-closed-after-open", 0],
                ["rpc-sent-then-closed", 1],
              ] as const) {
                const result = yield* probe(runtime, name);
                expect(result, name).toMatchObject({
                  outcome: "failed",
                  connections: 1,
                  failure: { tag: "closed" },
                });
                expect(result.attributes, name).toMatchObject({
                  [`${rpc}opened`]: true,
                  [`${rpc}sent`]: sent,
                });
                expect(
                  Object.keys(result.attributes).filter((key) => key.includes("connect_")),
                  name,
                ).toEqual([]);
              }
            }),
          );

          yield* evidence.step(
            `${runtime}: an HTTP exchange refused at connect is run once more from its start`,
            Effect.gen(function* () {
              const rescued = yield* probe(runtime, "http-rescued");
              expect(rescued).toMatchObject({ outcome: "answered", attempts: 2, connections: 1 });
              expect(rescued.attributes).not.toHaveProperty(`${http}stage`);
              expect(rescued.attributes).toMatchObject({
                [`${http}connect_attempts`]: 2,
                [`${http}first_attempt.error_code`]: "ECONNREFUSED",
                [`${http}connect_outcome`]: "answered",
              });
              const unreachable = yield* probe(runtime, "http-unreachable");
              expect(unreachable).toMatchObject({ outcome: "failed", attempts: 2 });
              expect(unreachable.attributes).toMatchObject({
                [`${http}connect_attempts`]: 2,
                [`${http}connect_outcome`]: "failed",
                [`${http}stage`]: "request",
              });
            }),
          );

          yield* evidence.step(
            `${runtime}: an HTTP request whose bytes were written is never repeated`,
            Effect.gen(function* () {
              for (const name of ["http-reset-after-write", "http-closed-after-write"]) {
                const result = yield* probe(runtime, name);
                expect(result, name).toMatchObject({
                  outcome: "failed",
                  attempts: 1,
                  connections: 1,
                });
                expect(
                  Object.keys(result.attributes).filter((key) => key.includes("connect_")),
                  name,
                ).toEqual([]);
              }
            }),
          );
        }

        yield* evidence.step(
          "A call whose only exchange with the app never left the host may be repeated; one that reached the app earlier may have written",
          Effect.gen(function* () {
            expect(yield* probe("node", "call-first-exchange")).toMatchObject({
              notSent: true,
              mayHaveWritten: false,
              retryable: true,
              action: "Try the call again.",
              reason:
                "Executor could not connect to the app runtime, so it did not send this tool call.",
            });
            expect(yield* probe("node", "call-second-exchange")).toMatchObject({
              notSent: false,
              mayHaveWritten: true,
              retryable: false,
              reason:
                "Executor could not reach the app runtime to finish this tool call. An earlier step of the call reached the app, so the call may have partly run.",
            });
            expect(yield* probe("node", "call-second-exchange-read")).toMatchObject({
              notSent: true,
              mayHaveWritten: false,
            });
          }),
        );

        yield* evidence.step(
          "Through the SDK's call path, a call says it was not sent only when its never-opened exchange was its only hand-off to the app",
          Effect.gen(function* () {
            expect(yield* callPath("call-once")).toMatchObject({
              operations: ["call"],
              failure: {
                tag: "ToolCallFailed",
                reason: notSentSentence,
                notSent: true,
                mayHaveWritten: false,
              },
            });
            expect(yield* callPath("call-after-kind-read")).toMatchObject({
              operations: ["inspect", "call"],
              failure: { reason: partlyRunSentence, notSent: false, mayHaveWritten: true },
            });
            expect(yield* callPath("call-resumed")).toMatchObject({
              asked: "approval-required",
              operations: ["call", "call"],
              failure: { reason: partlyRunSentence, notSent: false, mayHaveWritten: true },
            });
          }),
        );

        yield* evidence.step(
          "A host's check runs before every connect, the repeat's included, and a session's own reason is kept with notSent",
          Effect.gen(function* () {
            expect(yield* probe("node", "rpc-check-before-each-connect")).toMatchObject({
              checks: [0, 1],
              connections: 2,
            });
            expect(yield* probe("node", "rpc-never-opens-own-reason")).toMatchObject({
              connections: 2,
              failure: { tag: "RuntimeProtocolFailed", reason: "overloaded", notSent: true },
            });
          }),
        );

        yield* evidence.step(
          "A never-opened exchange's failure carries only values the previous release reads, and this release reads that release's answers",
          Effect.gen(function* () {
            const { wire } = yield* probe("node", "wire-previous-release");
            expect(wire?.values).toHaveLength(3);
            for (const value of wire?.values ?? []) {
              expect(value, value.label).toMatchObject({
                failure: "disconnected",
                known: true,
                notSent: true,
              });
            }
            expect(wire?.read.filter(({ decoded }) => !decoded)).toEqual([]);
            expect(wire?.read).toHaveLength(6);
            expect(wire?.partlyRunDropsNotSent).toBe(true);
          }),
        );

        yield* evidence.step(
          "An HTTP failure is repeated only when the platform's own fields prove the connect failed; Bun's ETIMEDOUT is not",
          Effect.gen(function* () {
            const { decisions } = yield* probe("node", "connect-decision-shapes");
            expect(decisions).toEqual({
              bunRefused: true,
              bunTimedOut: false,
              bunReset: false,
              nodeConnectTimedOut: true,
              nodeReadReset: false,
              undiciConnectTimeout: true,
              notTransport: false,
            });
          }),
        );
      }),
    ),
  );
});
