import { AppSlug } from "@executor-js/sdk/core";
/** Interpreter lifecycle checks through public MCP backend operations and the real codemode interpreter. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApprovalRequestId,
  ElicitationFailed,
  AppId,
  DeploymentId,
  OwnerId,
  ToolName,
  type ToolPending,
} from "@executor-js/sdk/core";
import { Clock, Deferred, Effect, Fiber, Schema, Scope, Exit } from "effect";
import {
  defaultMcpLimits,
  ElicitationResponseInvalid,
  makeExecutions,
  type McpBackend,
} from "../src/index.ts";

class AccessDenied extends Schema.TaggedError<AccessDenied>()("AccessDenied", {}) {}
const app = AppId.make("app_fixture");
const deployment = DeploymentId.make("dpl_fixture");
const owner = OwnerId.make("fixture");
const setup = Effect.gen(function* () {
  const ledger: string[] = [];
  let sequence = 0;
  const pending = new Map<ApprovalRequestId, typeof ToolPending.Type>();
  const backend: McpBackend<Error> = {
    listSkills: () => Effect.die("Unexpected skill listing"),
    readSkill: () => Effect.die("Unexpected skill read"),
    authorizeElicitation: () => Effect.void,
    listTargets: () => Effect.succeed([{ kind: "app" }]),
    listApps: () => Effect.succeed([{ id: app, slug: AppSlug.make("fixture"), name: "Fixture" }]),
    listTools: () =>
      Effect.succeed({
        deployment,
        items: ["before", "guarded", "after", "wait"].map((name) => ({
          app,
          deployment,
          name: ToolName.make(name),
          description: name,
          inputSchema: { type: "object" },
        })),
      }),
    callTool: (input) =>
      Effect.gen(function* () {
        if (input.tool === "guarded") {
          const request: typeof ToolPending.Type = {
            status: "approval-required",
            requestId: ApprovalRequestId.make(`apr_${++sequence}`),
            expiresAt: (yield* Clock.currentTimeMillis) + 900_000,
            elicitation: {
              mode: "form",
              message: "Approve guarded?",
              requestedSchema: { type: "object", properties: {} },
            },
            invocation: {
              app,
              owner,
              deployment,
              tool: input.tool,
              input: input.input ?? {},
              accounts: {},
            },
          };
          pending.set(request.requestId, request);
          return request;
        }
        ledger.push(input.tool);
        return { status: "completed" as const, value: input.tool };
      }),
    resumeInvocation: (request, response) =>
      Effect.sync(() => {
        if (!pending.delete(request.requestId))
          return { status: "already-consumed" as const, requestId: request.requestId };
        if (response.action === "decline")
          return { status: "denied" as const, requestId: request.requestId };
        if (response.action === "cancel")
          return { status: "cancelled" as const, requestId: request.requestId };
        ledger.push("approved");
        return { status: "completed" as const, value: "approved" };
      }),
  };
  return { backend, ledger };
});

test(
  "resume uses fresh authority and does not reuse the original backend",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup;
          const engine = yield* makeExecutions(defaultMcpLimits);
          const paused = yield* engine.execute(
            "caller",
            f.backend,
            "await tools.fixture.before({}); await tools.fixture.guarded({}); return await tools.fixture.after({});",
          );
          assert.equal(paused.status, "approval-required");
          if (paused.status !== "approval-required") throw new Error("Expected pause");
          const deniedBackend: McpBackend<Error> = {
            ...f.backend,
            resumeInvocation: () => Effect.fail(new AccessDenied()),
            callTool: () => Effect.fail(new AccessDenied()),
          };
          assert.equal(
            (yield* engine.resume("other", f.backend, {
              requestId: paused.requestId,
              response: { action: "accept" },
            })).status,
            "unavailable",
          );
          const result = yield* engine.resume("caller", deniedBackend, {
            requestId: paused.requestId,
            response: { action: "accept" },
          });
          assert.equal(result.status, "completed");
          if (result.status === "completed") {
            assert.equal(result.execution.ok, false);
            if (!result.execution.ok) assert.equal(result.execution.error.message, "AccessDenied");
          }
          assert.deepEqual(f.ledger, ["before"]);
        }),
      ),
    ),
);

test(
  "approval waiting freezes program work and does not consume execution time",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup;
          const engine = yield* makeExecutions({ ...defaultMcpLimits, timeoutMs: 120 });
          // Unawaited work cannot spin indefinitely while a human is deciding.
          const paused = yield* engine.execute(
            "caller",
            f.backend,
            "const p = tools.fixture.guarded({}); while (true) {}",
          );
          // The loop either exhausts its active budget before parking or parks at the approval boundary.
          if (paused.status === "approval-required") {
            yield* Effect.sleep("200 millis");
            const result = yield* engine.resume("caller", f.backend, {
              requestId: paused.requestId,
              response: { action: "accept" },
            });
            assert.equal(result.status, "completed");
            if (result.status === "completed") {
              assert.equal(result.execution.ok, false);
              if (!result.execution.ok)
                assert.equal(result.execution.error.kind, "TimeoutExceeded");
            }
          } else {
            assert.equal(paused.status, "completed");
            if (paused.status === "completed") assert.equal(paused.execution.ok, false);
          }
        }),
      ),
    ),
);

test(
  "concurrent duplicate resumes do not repeat calls and continuation results are not replayed",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup;
          const engine = yield* makeExecutions(defaultMcpLimits);
          const paused = yield* engine.execute(
            "caller",
            f.backend,
            "return await tools.fixture.guarded({});",
          );
          assert.equal(paused.status, "approval-required");
          if (paused.status !== "approval-required") throw new Error("Expected pause");
          const results = yield* Effect.all(
            Array.from({ length: 8 }, () =>
              engine.resume("caller", f.backend, {
                requestId: paused.requestId,
                response: { action: "accept" },
              }),
            ),
            { concurrency: 8 },
          );
          assert.equal(results.filter((result) => result.status === "completed").length, 1);
          assert.equal(results.filter((result) => result.status === "unavailable").length, 7);
          assert.deepEqual(f.ledger, ["approved"]);
        }),
      ),
    ),
);

test(
  "expired and lost continuations fail without invoking the SDK resume",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup;
          const engine = yield* makeExecutions(defaultMcpLimits);
          const paused = yield* engine.execute(
            "caller",
            f.backend,
            "return await tools.fixture.guarded({});",
          );
          if (paused.status !== "approval-required") throw new Error("Expected pause");
          const clock = yield* Clock.Clock;
          const now = paused.expiresAt + 1;
          const expired = yield* engine
            .resume("caller", f.backend, {
              requestId: paused.requestId,
              response: { action: "accept" },
            })
            .pipe(
              Effect.provideService(Clock.Clock, {
                currentTimeMillis: Effect.succeed(now),
                currentTimeMillisUnsafe: () => now,
                currentTimeNanos: Effect.succeed(BigInt(now) * 1_000_000n),
                currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
                monotonicTimeNanos: clock.monotonicTimeNanos,
                monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
                sleep: (duration) => clock.sleep(duration),
              }),
            );
          assert.equal(expired.status, "unavailable");
          const other = yield* engine.execute(
            "caller",
            f.backend,
            "return await tools.fixture.guarded({});",
          );
          if (other.status !== "approval-required") throw new Error("Expected pause");
          const restarted = yield* makeExecutions(defaultMcpLimits);
          assert.equal(
            (yield* restarted.resume("caller", f.backend, {
              requestId: other.requestId,
              response: { action: "accept" },
            })).status,
            "unavailable",
          );
          assert.deepEqual(f.ledger, []);
        }),
      ),
    ),
);

test("discard releases every pause in a program and only its caller can discard it", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const engine = yield* makeExecutions(defaultMcpLimits);
        const first = yield* engine.execute(
          "caller",
          f.backend,
          "return await Promise.all([tools.fixture.guarded({}), tools.fixture.guarded({})]);",
        );
        if (first.status !== "approval-required") throw new Error("Expected pause");
        yield* engine.discard("other", first.requestId);
        const next = yield* engine.resume("caller", f.backend, {
          requestId: first.requestId,
          response: { action: "accept" },
        });
        if (next.status !== "approval-required") throw new Error("Expected second pause");
        yield* engine.discard("caller", next.requestId);
        assert.equal(
          (yield* engine.resume("caller", f.backend, {
            requestId: next.requestId,
            response: { action: "accept" },
          })).status,
          "unavailable",
        );
        assert.deepEqual(f.ledger, ["approved"]);
        // All 64 slots are available after discard; no abandoned program remains.
        for (let i = 0; i < 64; i++) {
          assert.equal(
            (yield* engine.execute("caller", f.backend, "return await tools.fixture.guarded({});"))
              .status,
            "approval-required",
          );
        }
        assert.equal(
          (yield* engine.execute("caller", f.backend, "return 1")).status,
          "capacity-exceeded",
        );
      }),
    ),
  ));

test(
  "cancellation interrupts an active backend call and closing the host releases paused programs",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup;
          const started = yield* Deferred.make<void>();
          const released = yield* Deferred.make<void>();
          const backend = {
            ...f.backend,
            callTool: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(released, undefined)),
              ),
          };
          const scope = yield* Scope.make();
          const engine = yield* makeExecutions(defaultMcpLimits).pipe(Scope.provide(scope));
          const running = yield* engine
            .execute("caller", backend, "return await tools.fixture.wait({});")
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(running);
          yield* Deferred.await(released);
          const paused = yield* engine.execute(
            "caller",
            f.backend,
            "return await tools.fixture.guarded({});",
          );
          if (paused.status !== "approval-required") throw new Error("Expected pause");
          yield* Scope.close(scope, Exit.void);
          assert.equal(
            (yield* engine.resume("caller", f.backend, {
              requestId: paused.requestId,
              response: { action: "accept" },
            })).status,
            "unavailable",
          );
          assert.deepEqual(f.ledger, []);
        }),
      ),
    ),
);

test("all calls after a pause use the resuming request's backend", { timeout: 10_000 }, () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const engine = yield* makeExecutions(defaultMcpLimits);
        const paused = yield* engine.execute(
          "caller",
          f.backend,
          "await tools.fixture.guarded({}); return await tools.fixture.after({});",
        );
        if (paused.status !== "approval-required") throw new Error("Expected pause");
        const secondLedger: string[] = [];
        const resumed: McpBackend<Error> = {
          ...f.backend,
          callTool: (input) =>
            Effect.sync(() => {
              secondLedger.push(input.tool);
              return { status: "completed" as const, value: "fresh-request" };
            }),
        };
        const result = yield* engine.resume("caller", resumed, {
          requestId: paused.requestId,
          response: { action: "accept" },
        });
        assert.equal(result.status, "completed");
        if (result.status === "completed")
          assert.deepEqual(result.execution.ok && result.execution.value, "fresh-request");
        assert.deepEqual(f.ledger, ["approved"]);
        assert.deepEqual(secondLedger, ["after"]);
      }),
    ),
  ),
);

test("active execution budget is cumulative across pauses", { timeout: 10_000 }, () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const engine = yield* makeExecutions({ ...defaultMcpLimits, timeoutMs: 250 });
        const backend: McpBackend<Error> = {
          ...f.backend,
          callTool: (input) =>
            input.tool === "guarded"
              ? f.backend.callTool(input)
              : f.backend.callTool(input).pipe(Effect.delay("160 millis")),
        };
        const paused = yield* engine.execute(
          "caller",
          backend,
          "await tools.fixture.before({}); await tools.fixture.guarded({}); return await tools.fixture.after({});",
        );
        assert.equal(paused.status, "approval-required");
        if (paused.status !== "approval-required") throw new Error("Expected pause");
        yield* Effect.sleep("300 millis");
        const result = yield* engine.resume("caller", backend, {
          requestId: paused.requestId,
          response: { action: "accept" },
        });
        assert.equal(result.status, "completed");
        if (result.status === "completed") {
          assert.equal(result.execution.ok, false);
          if (!result.execution.ok) assert.equal(result.execution.error.kind, "TimeoutExceeded");
          assert.deepEqual(
            result.execution.toolCalls.map((call) => call.name),
            ["fixture.before", "fixture.guarded", "fixture.after"],
          );
        }
      }),
    ),
  ),
);

test(
  "a concurrent resume for a different pending call reports busy until the current drive finishes",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup;
          const exposed: Array<typeof ToolPending.Type> = [];
          const backend: McpBackend<Error> = {
            ...f.backend,
            callTool: (input) =>
              f.backend.callTool(input).pipe(
                Effect.tap((result) =>
                  Effect.sync(() => {
                    if (result.status === "approval-required") exposed.push(result);
                  }),
                ),
              ),
          };
          const engine = yield* makeExecutions(defaultMcpLimits);
          const first = yield* engine.execute(
            "caller",
            backend,
            "return await Promise.all([tools.fixture.guarded({}), tools.fixture.guarded({})]);",
          );
          if (first.status !== "approval-required") throw new Error("Expected pause");
          assert.equal(exposed.length, 2);
          const other = exposed.find((request) => request.requestId !== first.requestId);
          assert.ok(other);
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const waiting: McpBackend<Error> = {
            ...backend,
            resumeInvocation: (request, response) =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(f.backend.resumeInvocation(request, response)),
              ),
          };
          const running = yield* engine
            .resume("caller", waiting, {
              requestId: first.requestId,
              response: { action: "accept" },
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          assert.equal(
            (yield* engine.resume("caller", backend, {
              requestId: other.requestId,
              response: { action: "accept" },
            })).status,
            "busy",
          );
          yield* Deferred.succeed(release, undefined);
          const next = yield* Fiber.join(running);
          assert.equal(next.status, "approval-required");
          const done = yield* engine.resume("caller", backend, {
            requestId: other.requestId,
            response: { action: "accept" },
          });
          assert.equal(done.status, "completed");
          assert.deepEqual(f.ledger, ["approved", "approved"]);
        }),
      ),
    ),
);

test(
  "an oversized approval preview fails without executing or truncating the consent",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup;
          const engine = yield* makeExecutions({ ...defaultMcpLimits, maxOutputBytes: 500 });
          const result = yield* engine.execute(
            "caller",
            f.backend,
            'return await tools.fixture.guarded({message: "x".repeat(2000)});',
          );
          assert.equal(result.status, "completed");
          if (result.status === "completed") {
            assert.equal(result.execution.ok, false);
            if (!result.execution.ok)
              assert.equal(result.execution.error.message, "ApprovalTooLarge");
          }
          assert.deepEqual(f.ledger, []);
        }),
      ),
    ),
);

test(
  "resume validates elicitation responses before claiming the continuation",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup;
          const engine = yield* makeExecutions(defaultMcpLimits);
          const paused = yield* engine.execute(
            "caller",
            f.backend,
            "return await tools.fixture.guarded({});",
          );
          if (paused.status !== "approval-required") throw new Error("Expected pause");
          const invalid = {
            requestId: paused.requestId,
            response: { action: "accept" as const, content: { value: "changed" } },
          };
          assert.ok(
            Schema.is(ElicitationResponseInvalid)(
              yield* Effect.flip(engine.resume("caller", f.backend, invalid)),
            ),
          );
          const cancelled = yield* engine.resume("caller", f.backend, {
            requestId: paused.requestId,
            response: { action: "cancel" },
          });
          assert.equal(cancelled.status, "completed");
          if (cancelled.status === "completed") {
            assert.equal(cancelled.execution.ok, false);
            if (!cancelled.execution.ok)
              assert.equal(cancelled.execution.error.message, "ApprovalCancelled");
          }
          assert.deepEqual(f.ledger, []);
        }),
      ),
    ),
);

const inputForm = {
  mode: "form" as const,
  message: "Name this result",
  requestedSchema: {
    type: "object" as const,
    properties: { name: { type: "string" as const } },
    required: ["name"],
  },
};

test(
  "a running invocation owns its scope between requests and fresh authority gates its answer",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup;
          let acquired = 0,
            released = 0,
            answered = 0;
          const backend: McpBackend<Error> = {
            ...f.backend,
            callTool: (_input, options) =>
              Effect.gen(function* () {
                yield* Effect.acquireRelease(
                  Effect.sync(() => {
                    acquired++;
                  }),
                  () =>
                    Effect.sync(() => {
                      released++;
                    }),
                );
                if (options?.elicitation === undefined) throw new Error("Missing input capability");
                yield* options.elicitation(inputForm, new AbortController().signal);
                answered++;
                return { status: "completed" as const, value: "done" };
              }).pipe(Effect.scoped),
          };
          const engine = yield* makeExecutions(defaultMcpLimits);
          const pause = yield* Effect.scoped(
            engine.execute("caller", backend, "return await tools.fixture.before({});"),
          );
          if (pause.status !== "input-required") throw new Error("Expected tool input");
          assert.equal(acquired, 1);
          assert.equal(released, 0);
          assert.equal(
            (yield* engine.resume("other", backend, {
              requestId: pause.requestId,
              response: { action: "accept", content: { name: "wrong caller" } },
            })).status,
            "unavailable",
          );
          const denied = yield* engine.resume(
            "caller",
            {
              ...backend,
              authorizeElicitation: () =>
                Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
            },
            {
              requestId: pause.requestId,
              response: { action: "accept", content: { name: "blocked" } },
            },
          );
          assert.ok(denied.status === "completed" && !denied.execution.ok);
          assert.equal(acquired, 1);
          assert.equal(released, 1);
          assert.equal(answered, 0);
        }),
      ),
    ),
);

test(
  "discard, expiry and host shutdown cancel running input and release invocation resources",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup;
          for (const reason of ["discard", "expiry", "shutdown"] as const) {
            const scope = yield* Scope.make();
            const engine = yield* makeExecutions(defaultMcpLimits).pipe(Scope.provide(scope));
            let released = false;
            const backend: McpBackend<Error> = {
              ...f.backend,
              callTool: (_input, options) =>
                Effect.gen(function* () {
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                      released = true;
                    }),
                  );
                  if (options?.elicitation === undefined)
                    throw new Error("Missing input capability");
                  yield* options.elicitation(inputForm, new AbortController().signal);
                  throw new Error("Cancelled input must not continue");
                }).pipe(Effect.scoped),
            };
            const pause = yield* engine.execute(
              "caller",
              backend,
              "return await tools.fixture.before({});",
            );
            if (pause.status !== "input-required") throw new Error("Expected tool input");
            if (reason === "discard") yield* engine.discard("caller", pause.requestId);
            else if (reason === "shutdown") yield* Scope.close(scope, Exit.void);
            else {
              const clock = yield* Clock.Clock;
              const now = pause.expiresAt + 1;
              const expired = yield* engine
                .resume("caller", backend, {
                  requestId: pause.requestId,
                  response: { action: "cancel" },
                })
                .pipe(
                  Effect.provideService(Clock.Clock, {
                    ...clock,
                    currentTimeMillis: Effect.succeed(now),
                    currentTimeMillisUnsafe: () => now,
                  }),
                );
              assert.equal(expired.status, "unavailable");
            }
            assert.equal(released, true, reason);
            assert.equal(
              (yield* engine.resume("caller", backend, {
                requestId: pause.requestId,
                response: { action: "cancel" },
              })).status,
              "unavailable",
            );
            yield* Scope.close(scope, Exit.void);
          }
        }),
      ),
    ),
);

test(
  "a tool cancelling its parked question releases the whole execution",
  { timeout: 10_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup;
          const cancelled = new AbortController();
          const released = yield* Deferred.make<void>();
          const backend: McpBackend<Error> = {
            ...f.backend,
            callTool: (_input, options) =>
              Effect.gen(function* () {
                if (options?.elicitation === undefined) throw new Error("Missing input capability");
                yield* options.elicitation(inputForm, cancelled.signal);
                return { status: "completed" as const, value: "unexpected" };
              }).pipe(Effect.ensuring(Deferred.succeed(released, undefined))),
          };
          const engine = yield* makeExecutions(defaultMcpLimits);
          const pending = yield* engine.execute(
            "caller",
            backend,
            "return await tools.fixture.before({});",
          );
          if (pending.status !== "input-required") throw new Error("Expected tool input");
          cancelled.abort();
          yield* Deferred.await(released);
          yield* Effect.yieldNow;
          assert.equal(
            (yield* engine.resume("caller", backend, {
              requestId: pending.requestId,
              response: { action: "cancel" },
            })).status,
            "unavailable",
          );
          for (let i = 0; i < 64; i++)
            assert.equal(
              (yield* engine.execute(
                "caller",
                f.backend,
                "return await tools.fixture.guarded({});",
              )).status,
              "approval-required",
            );
        }),
      ),
    ),
);
