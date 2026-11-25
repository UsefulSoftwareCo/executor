import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
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
  first: Schema.optional(Schema.Literals(["answered", "failed"])),
  sameErrorHttp: Schema.optional(Schema.Boolean),
  sameErrorRpc: Schema.optional(Schema.Boolean),
  classified: Schema.optional(Schema.Boolean),
  attributes: Attributes,
  rpcAttributes: Schema.optional(Attributes),
  longAttributes: Schema.optional(Attributes),
});

const probe = (name: string) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner,
      evidence = yield* Evidence;
    const output = yield* processes.string(
      ChildProcess.make("node", ["packages/sdk/scripts/runtime-hop-fixture.ts", "--case", name], {
        env: { PATH: process.env.PATH ?? "" },
        extendEnv: false,
      }),
    );
    const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Probe))(
      output.trim().split("\n").at(-1) ?? "",
    );
    yield* evidence.json(`runtime-hop-${name}.json`, result);
    return result;
  });

const under = (attributes: Record<string, unknown>, prefix: string) =>
  Object.keys(attributes).filter((key) => key.startsWith(prefix));

layer(TestLive, { excludeTestServices: true })("Runtime hop shape", (it) => {
  it.effect(scenarios.runtimeHopShape.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence;

        yield* evidence.step(
          "An HTTP exchange records how far it got: no headers, headers then a reset, a reset while writing",
          Effect.gen(function* () {
            const unanswered = yield* probe("http-unanswered");
            expect(unanswered.outcome).toBe("failed");
            expect(unanswered.attributes).toMatchObject({
              "executor.runtime.http.route": "/workflow",
              "executor.runtime.http.method": "POST",
              "executor.runtime.http.stage": "request",
              "executor.runtime.http.error": "HttpClientError",
              "executor.runtime.http.reason": "TransportError",
              "executor.runtime.http.code": "UND_ERR_SOCKET",
              "executor.runtime.host.restarts": 0,
            });
            expect(unanswered.attributes).not.toHaveProperty("executor.runtime.http.headers_ms");
            expect(unanswered.attributes["executor.runtime.http.failed_ms"]).toBeGreaterThanOrEqual(
              100,
            );

            const reset = yield* probe("http-answer-reset");
            expect(reset.outcome).toBe("failed");
            expect(reset.attributes).toMatchObject({
              "executor.runtime.http.stage": "response-body",
              "executor.runtime.http.status": 200,
              "executor.runtime.http.reason": "DecodeError",
              "executor.runtime.http.code": "ECONNRESET",
              "executor.runtime.http.syscall": "read",
            });
            expect(typeof reset.attributes["executor.runtime.http.headers_ms"]).toBe("number");
            expect(typeof reset.attributes["executor.runtime.http.errno"]).toBe("number");

            const halfWritten = yield* probe("http-reset-half-written");
            expect(halfWritten.outcome).toBe("failed");
            expect(halfWritten.attributes).toMatchObject({
              "executor.runtime.http.stage": "request",
              "executor.runtime.http.reason": "TransportError",
              "executor.runtime.http.code": "ECONNRESET",
            });
            expect(halfWritten.attributes).not.toHaveProperty("executor.runtime.http.headers_ms");
          }),
        );

        yield* evidence.step(
          "A failure records how long the runtime's origin was idle and how recently the runtime was replaced",
          Effect.gen(function* () {
            const idle = yield* probe("http-idle");
            expect(idle.first).toBe("answered");
            expect(idle.attributes["executor.runtime.http.idle_ms"]).toBeGreaterThanOrEqual(140);
            const restarted = yield* probe("http-restarted");
            expect(restarted.attributes).toMatchObject({ "executor.runtime.host.restarts": 2 });
            expect(
              restarted.attributes["executor.runtime.host.restarted_ms"],
            ).toBeGreaterThanOrEqual(75);
          }),
        );

        yield* evidence.step(
          "An exchange that succeeds records nothing",
          Effect.gen(function* () {
            const { outcome, attributes } = yield* probe("http-unread-body");
            expect(outcome).toBe("answered");
            expect(attributes).toEqual({});
          }),
        );

        yield* evidence.step(
          "A value built to break the recording leaves the same error, classified the same",
          Effect.gen(function* () {
            for (const name of ["guard-throwing-getter", "guard-proxy"]) {
              const result = yield* probe(name);
              expect(result, name).toMatchObject({
                sameErrorHttp: true,
                sameErrorRpc: true,
                classified: true,
              });
              expect(result.attributes, name).toEqual({ "executor.runtime.recording": "failed" });
            }
            const context = yield* probe("guard-throwing-context");
            expect(context).toMatchObject({
              sameErrorHttp: true,
              sameErrorRpc: true,
              classified: true,
            });
            expect(context.attributes).toMatchObject({
              "executor.runtime.probe.recording": "failed",
              "executor.runtime.http.stage": "request",
            });
            const socket = yield* probe("guard-throwing-socket");
            expect(socket).toMatchObject({
              sameErrorHttp: true,
              sameErrorRpc: true,
              classified: true,
            });
            expect(socket.rpcAttributes).toEqual({ "executor.runtime.recording": "failed" });
          }),
        );

        yield* evidence.step(
          "A supervisor's context keeps only its own keys with short values, and an odd error tag is other",
          Effect.gen(function* () {
            const { attributes } = yield* probe("context-checked");
            expect(under(attributes, "executor.runtime.probe.").sort()).toEqual([
              "executor.runtime.probe.in_flight",
              "executor.runtime.probe.outcome",
              "executor.runtime.probe.sequence",
            ]);
            expect(attributes).toMatchObject({
              "executor.runtime.probe.sequence": 7,
              "executor.runtime.probe.outcome": "timeout",
              "executor.runtime.probe.in_flight": true,
              "executor.runtime.http.route": "/workflow",
              "executor.runtime.http.error": "other",
              "executor.runtime.http.code": "other",
              "executor.runtime.http.syscall": "other",
            });
            expect(
              Object.keys(attributes).some((key) => !key.startsWith("executor.runtime.")),
            ).toBe(false);
            expect(attributes).not.toHaveProperty("executor.runtime.forged");
            expect(attributes).not.toHaveProperty("executor.runtime.http.forged");
          }),
        );

        yield* evidence.step(
          "A platform code as long as Node's and undici's longer ones is recorded whole; a longer one is other",
          Effect.gen(function* () {
            const { attributes, rpcAttributes, longAttributes } = yield* probe("code-long");
            expect(longAttributes?.["executor.runtime.http.code"]).toBe("other");
            expect(attributes["executor.runtime.http.code"]).toBe("ERR_STREAM_PREMATURE_CLOSE");
            expect(rpcAttributes?.["executor.runtime.http.code"]).toBe(
              "UND_ERR_RESPONSE_STATUS_CODE",
            );
          }),
        );

        yield* evidence.step(
          "An RPC socket that never opens: refused, and accepted then closed before the upgrade",
          Effect.gen(function* () {
            const refused = yield* probe("ws-refused");
            expect(refused.attributes).toMatchObject({
              "executor.runtime.rpc.opened": false,
              "executor.runtime.rpc.close_code": 1006,
              "executor.runtime.rpc.error_code": "ECONNREFUSED",
              "executor.runtime.rpc.sent": 0,
              "executor.runtime.rpc.received": 0,
            });
            expect(refused.attributes).not.toHaveProperty("executor.runtime.rpc.open_ms");
            const beforeUpgrade = yield* probe("ws-closed-before-upgrade");
            expect(beforeUpgrade.attributes).toMatchObject({
              "executor.runtime.rpc.opened": false,
              "executor.runtime.rpc.close_code": 1006,
              "executor.runtime.rpc.error_code": "ECONNRESET",
            });
          }),
        );

        yield* evidence.step(
          "An RPC socket closed with a code before any message, and one closed after a message each way",
          Effect.gen(function* () {
            const before = yield* probe("ws-close-before-message");
            expect(before.attributes).toMatchObject({
              "executor.runtime.rpc.opened": true,
              "executor.runtime.rpc.close_code": 4001,
              "executor.runtime.rpc.close_reason": "none",
              "executor.runtime.rpc.sent": 0,
              "executor.runtime.rpc.received": 0,
            });
            expect(before.attributes).not.toHaveProperty("executor.runtime.rpc.last_received_ms");
            const after = yield* probe("ws-close-after-message");
            expect(after.attributes).toMatchObject({
              "executor.runtime.rpc.opened": true,
              "executor.runtime.rpc.close_code": 1011,
              "executor.runtime.rpc.sent": 1,
              "executor.runtime.rpc.received": 1,
            });
            const failedMs = Number(after.attributes["executor.runtime.rpc.failed_ms"]);
            const lastReceivedMs = Number(
              after.attributes["executor.runtime.rpc.last_received_ms"],
            );
            expect(failedMs).toBeGreaterThanOrEqual(30);
            expect(after.attributes["executor.runtime.rpc.closed_ms"]).toBeGreaterThanOrEqual(30);
            expect(lastReceivedMs).toBeGreaterThanOrEqual(30);
            expect(lastReceivedMs).toBeLessThanOrEqual(failedMs);
          }),
        );

        yield* evidence.step(
          "An RPC session records only a transport failure: not an app's failure, a success or an interruption",
          Effect.gen(function* () {
            for (const name of ["rpc-app-failure", "rpc-success", "rpc-interrupt"]) {
              const { attributes } = yield* probe(name);
              expect(under(attributes, "executor.runtime."), name).toEqual([]);
            }
          }),
        );
      }),
    ),
  );
});
