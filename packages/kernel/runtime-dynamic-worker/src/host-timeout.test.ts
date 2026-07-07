// ---------------------------------------------------------------------------
// Host-side execution timeout — the unresponsive-sandbox backstop.
//
// The ONLY timeout on code execution used to be the in-SANDBOX Promise.race in
// module-template.ts. If the isolate is evicted / OOM-killed in a way that
// wedges the cross-isolate `evaluate` RPC WITHOUT rejecting, that timer never
// fires and the host side awaited the RPC forever: the client saw pure silence
// (SSE keepalives, no JSON-RPC frame) for the DO's whole running-work lease.
//
// These tests drive that exact shape through the PUBLIC executor path with a
// fake WorkerLoader whose `evaluate()` never settles. On the unpatched code the
// "delivers a typed timeout error" test HANGS and only fails via the bounded
// vitest testTimeout (red-by-timeout repro); with the host backstop it delivers
// a descriptive `ExecuteResult.error` well inside the bound. The pause-survival
// test guards the correctness risk of the change: an execution blocked in a
// host round-trip (a slow tool call or a minutes-long approval pause) must NOT
// be killed by the backstop.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Data from "effect/Data";
import type { SandboxToolInvoker } from "@executor-js/codemode-core";

import {
  makeDynamicWorkerExecutor,
  runEvaluateWithHostTimeout,
  type DispatcherActivity,
} from "./executor";

// A never-invoked tool invoker — the wedge cases never reach a tool call.
const idleInvoker: SandboxToolInvoker = {
  invoke: () => Effect.succeed(undefined),
};

// Build a fake WorkerLoader whose loaded worker's `evaluate()` resolves with
// `settle()` (or never, if `settle` is never called). Enough surface for
// `startDynamicWorker` -> `worker.getEntrypoint().evaluate(dispatcher)`.
const makeFakeLoader = (evaluate: () => Promise<unknown>) => {
  const entrypoint = { evaluate };
  const stub = { getEntrypoint: () => entrypoint };
  // oxlint-disable-next-line executor/no-double-cast -- test double for the Cloudflare WorkerLoader binding; only get()/getEntrypoint()/evaluate() are exercised
  return { get: () => stub, load: () => stub } as unknown as WorkerLoader;
};

// A dispatcher-activity double the watchdog observes directly.
const activity = (init: Partial<DispatcherActivity> = {}): DispatcherActivity => ({
  isDispatching: false,
  lastReturnedAt: 0,
  ...init,
});

class NeverError extends Data.TaggedError("NeverError")<{ readonly message: string }> {}

// A promise that never settles — the wedged RPC.
const never = <A>(): Promise<A> => new Promise<A>(() => {});

describe("host execution timeout (public execute path)", () => {
  it("delivers a descriptive timeout error when the evaluate RPC never settles", async () => {
    // The wedge: evaluate() never resolves and never rejects.
    const executor = makeDynamicWorkerExecutor({
      loader: makeFakeLoader(() => never()),
      timeoutMs: 200, // small in-sandbox bound so the backstop (bound + grace) is quick
      hostTimeoutGraceMs: 100,
      hostTimeoutPollMs: 20,
    });

    const started = Date.now();
    // On UNPATCHED code this Effect never completes and the test fails only via
    // the bounded vitest testTimeout. With the backstop it resolves with a
    // delivered, descriptive error.
    const result = await Effect.runPromise(executor.execute("return 1;", idleInvoker));
    const elapsed = Date.now() - started;

    expect(result.result).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error).toContain("unresponsive");
    // bound = 200 (timeout) + 100 (grace). Must have fired, not hung forever.
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(10_000);
  });

  it("passes a fast result straight through without waiting on the backstop", async () => {
    const executor = makeDynamicWorkerExecutor({
      loader: makeFakeLoader(() => Promise.resolve({ result: 42, logs: [] })),
      timeoutMs: 200,
    });

    const started = Date.now();
    const result = await Effect.runPromise(executor.execute("return 42;", idleInvoker));
    const elapsed = Date.now() - started;

    expect(result.result).toBe(42);
    expect(result.error).toBeUndefined();
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe("runEvaluateWithHostTimeout", () => {
  it("fires when the sandbox is on its own and produces nothing", async () => {
    let fired = false;
    const effect = runEvaluateWithHostTimeout(
      Effect.tryPromise({
        try: () => never<string>(),
        catch: (c) => new NeverError({ message: String(c) }),
      }),
      {
        timeoutMs: 50,
        graceMs: 50,
        pollMs: 10,
        dispatcher: activity(),
        onTimeout: () => {
          fired = true;
        },
      },
    );

    const exit = await Effect.runPromiseExit(effect);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fired).toBe(true);
  });

  it("does NOT fire while a tool round-trip / approval pause is outstanding", async () => {
    // The dispatcher reports it is dispatching for the entire window: the
    // sandbox is blocked in the host (a slow tool, or an approval pause), so
    // the backstop must hold its clock and never fire. The evaluate settles
    // only AFTER a span far exceeding timeoutMs+graceMs.
    const bound = 40; // timeoutMs 20 + graceMs 20
    let resolveEvaluate!: (value: { result: number }) => void;
    const pending = new Promise<{ result: number }>((resolve) => {
      resolveEvaluate = resolve;
    });

    let fired = false;
    const dispatcher = activity({ isDispatching: true, lastReturnedAt: Date.now() });
    const effect = runEvaluateWithHostTimeout(
      Effect.tryPromise({
        try: () => pending,
        catch: (c) => new NeverError({ message: String(c) }),
      }),
      {
        timeoutMs: 20,
        graceMs: 20,
        pollMs: 5,
        dispatcher,
        onTimeout: () => {
          fired = true;
        },
      },
    );

    const fiber = Effect.runFork(effect);

    // Wait well past the bound while "paused" (dispatching). The watchdog must
    // hold: no timeout should have fired.
    await new Promise((r) => setTimeout(r, bound * 6));
    expect(fired).toBe(false);

    // The pause ends: the tool/approval returns, evaluate settles. Result must
    // be delivered intact.
    resolveEvaluate({ result: 7 });
    const value = await Effect.runPromise(Fiber.join(fiber));
    expect(value).toEqual({ result: 7 });
    expect(fired).toBe(false);
  });

  it("fires after a dispatch returns and the sandbox then goes quiet", async () => {
    // A round-trip returned at t0 (advancing lastReturnedAt), then the sandbox
    // wedged with no further dispatch. The reference point is lastReturnedAt,
    // so the backstop still fires bound ms after that return.
    let fired = false;
    const dispatcher = activity({ isDispatching: false, lastReturnedAt: Date.now() });
    const effect = runEvaluateWithHostTimeout(
      Effect.tryPromise({
        try: () => never<string>(),
        catch: (c) => new NeverError({ message: String(c) }),
      }),
      {
        timeoutMs: 30,
        graceMs: 30,
        pollMs: 10,
        dispatcher,
        onTimeout: () => {
          fired = true;
        },
      },
    );

    const exit = await Effect.runPromiseExit(effect);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fired).toBe(true);
  });
});
