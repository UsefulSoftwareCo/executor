import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Predicate } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";

import type { Executor } from "@executor-js/sdk";

import { ExecutionsApi } from "../executions/api";
import { ExecutionsHandlers } from "./executions";
import { ExecutionEngineService, ExecutorService } from "../services";

// ---------------------------------------------------------------------------
// Focused tests — spec execution-tombstones, AC4 (resume-time surface).
//
// When the daemon restarts, the paused fiber is gone. A resume must NOT read
// as a generic "approval expired": if a tombstone exists for the execution
// (written before the restart), the resume surfaces the honest
// "interrupted — re-trigger" outcome (InterruptedExecutionError).
// ---------------------------------------------------------------------------

const stubExecutor = (record: { executionId: string; status: string } | null): Executor =>
  // oxlint-disable-next-line executor/no-double-cast -- minimal executor double: executionRecords.get and pendingApprovals.consume are exercised
  ({
    executionRecords: {
      get: () => Effect.succeed(record),
      put: () => Effect.void,
      sweepInterrupted: () => Effect.succeed({ interrupted: 0 }),
    },
    // resumeFromPendingApproval consumes a stored approval before reaching
    // the tombstone check; absent approvals are the restart scenario.
    pendingApprovals: {
      consume: () => Effect.succeed(null),
      discard: () => Effect.void,
      put: () => Effect.void,
    },
  }) as unknown as Executor;

// The engine remembers nothing (fresh process): live resume returns null, and
// there is no pending-approval record — this is the restart scenario.
// oxlint-disable-next-line executor/no-double-cast -- minimal engine double: only resume's null return (fresh process) is exercised
const emptyEngine = {
  resume: () => Effect.succeed(null),
} as unknown as ExecutionEngineService["Service"];

const runResume = (executor: Executor) => {
  const handler = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("executor").add(ExecutionsApi)).pipe(
      Layer.provide(ExecutionsHandlers),
      Layer.provide(Layer.succeed(ExecutorService)(executor)),
      Layer.provide(Layer.succeed(ExecutionEngineService)(emptyEngine)),
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
    ),
    { disableLogger: false },
  ).handler;
  // The handler's inferred type demands a Context<ExecutorService |
  // ExecutionEngineService> second argument at the type level (a beta.59
  // inference quirk of toWebHandler's ReqR) even though the layer above
  // provides both at runtime. Pass the runtime-provided context explicitly.
  // The handler's inferred type demands a Context<ExecutorService |
  // ExecutionEngineService> second argument at the type level (a beta.59
  // inference quirk of toWebHandler's ReqR) even though the layer above
  // provides both at runtime. Passing the real services explicitly also
  // satisfies the runtime — the stubs here are self-sufficient.
  const context = Context.make(ExecutorService, executor).pipe(
    Context.add(ExecutionEngineService, emptyEngine),
  );
  return handler(
    new Request("https://executor.test/executions/exec_1/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "accept" }),
    }),
    context,
  );
};

describe("resume after daemon restart (tombstone path)", () => {
  it("surfaces interrupted (404 + InterruptedExecutionError) when a tombstone exists", async () => {
    const res = await runResume(stubExecutor({ executionId: "exec_1", status: "interrupted" }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { _tag?: string; executionId?: string };
    expect(Predicate.isTagged(body, "InterruptedExecutionError")).toBe(true);
    expect(body.executionId).toBe("exec_1");
  });

  it("surfaces interrupted for a stale paused tombstone (sweep missed it — not a live execution)", async () => {
    const res = await runResume(stubExecutor({ executionId: "exec_1", status: "paused" }));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).toContain("InterruptedExecutionError");
  });

  it("falls through to approval-expired when no tombstone exists", async () => {
    const res = await runResume(stubExecutor(null));
    // ApprovalExpiredError is annotated httpApiStatus: 410 (Gone).
    expect(res.status).toBe(410);
    expect(JSON.stringify(await res.json())).toContain("ApprovalExpiredError");
  });

  it("completed tombstones do not resurrect (completed is immutable)", async () => {
    const res = await runResume(stubExecutor({ executionId: "exec_1", status: "completed" }));
    // No tombstone hit for completed (immutable) — falls through to expired (410).
    expect(res.status).toBe(410);
    expect(JSON.stringify(await res.json())).toContain("ApprovalExpiredError");
  });
});
