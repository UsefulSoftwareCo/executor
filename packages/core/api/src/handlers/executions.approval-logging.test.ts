import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";

import type { Executor } from "@executor-js/sdk";

import { ExecutionsApi } from "../executions/api";
import { ExecutionsHandlers } from "./executions";
import { ExecutionEngineService, ExecutorService } from "../services";
import { ErrorCapture } from "../observability";
import { StorageError } from "@executor-js/sdk";

// ---------------------------------------------------------------------------
// recordPendingApproval must NOT silently swallow persistence failures:
// the cause is captured through the host's ErrorCapture seam, and the
// execution outcome is unaffected (the artifact pause still returns
// "paused", not a 500).
// ---------------------------------------------------------------------------

// A pendingApprovals store whose put() always fails — simulating a storage
// hiccup at the moment of recording the durable approval record. Fails with a
// REAL StorageError (tagged, message + cause) so the handler's capture path
// sees exactly what a live storage hiccup produces.
const failingPendingApprovals = {
  put: () => Effect.fail(new StorageError({ message: "simulated storage failure", cause: null })),
  consume: () => Effect.succeed(null),
  discard: () => Effect.void,
};

const capturingErrors: string[] = [];
const capturingErrorCapture = Layer.succeed(ErrorCapture, {
  captureException: (cause) =>
    Effect.sync(() => {
      capturingErrors.push(Cause.pretty(cause));
      return "trace-test";
    }),
});

// Minimal executor double: everything dies unless this test needs it; only
// pendingApprovals.put and artifacts.get are exercised by the paused-artifact
// path (resolveArtifactCode reads the artifact, catching its own failures).
// oxlint-disable-next-line executor/no-double-cast -- minimal executor double: only pendingApprovals.put and artifacts.get are exercised
const failingExecutor = {
  pendingApprovals: failingPendingApprovals,
  artifacts: {
    // Real-shaped artifact with a binding for the role the test's action
    // code names ("repo") — resolveArtifactAction rewrites the role into
    // the connection address through this binding before the engine runs.
    get: () =>
      Effect.succeed({
        id: "artifact_1",
        bindings: {
          repo: { integration: "github", owner: "owner_1", connection: "conn_1" },
        },
      }),
  },
  // oxlint-disable-next-line executor/no-double-cast -- test stub: only the two members the pause path reads; the real Executor surface is far wider
} as unknown as Executor;
// Stub engine: executeWithPause returns a PAUSED outcome (artifact approval
// pause) — the branch that calls recordPendingApproval. The paused execution
// carries a real-shaped elicitationContext (request must be a tagged
// elicitation with a message — formatPausedExecution reads both).
// oxlint-disable-next-line executor/no-double-cast -- minimal engine double: only executeWithPause's paused branch is exercised
const pausedEngine = {
  executeWithPause: () =>
    Effect.succeed({
      status: "paused",
      execution: {
        id: "exec_1",
        elicitationContext: {
          address: "github.issues.create",
          args: {},
          request: {
            _tag: "ConfirmationElicitation",
            message: "Approve this action?",
          },
        },
      },
    }),
  // oxlint-disable-next-line executor/no-double-cast -- test stub: paused-outcome engine exercising only the recordPendingApproval branch
} as unknown as ExecutionEngineService["Service"];

// Mount ONLY the executions group — the other API groups (tools, oauth, …)
// have their own handler layers with live service deps; this test exercises
// the executions pause path alone.
const ExecutionsOnlyApi = HttpApi.make("executor").add(ExecutionsApi);

// oxlint-disable-next-line executor/no-double-cast -- the resulting handler is cast below to the 1-arg form the raw-web-request tests need (beta.59 ReqR inference demands a context param the runtime does not use)
const webHandler = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(ExecutionsOnlyApi).pipe(
    Layer.provide(ExecutionsHandlers),
    Layer.provide(Layer.succeed(ExecutorService)(failingExecutor)),
    Layer.provide(Layer.succeed(ExecutionEngineService)(pausedEngine)),
    Layer.provide(capturingErrorCapture),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
  ),
  { disableLogger: true },
).handler as unknown as (request: Request) => Promise<Response>;

const run = (body: unknown) =>
  webHandler(
    new Request("https://executor.test/executions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("recordPendingApproval failure logging", () => {
  it("captures the storage failure via ErrorCapture when the record cannot be persisted", async () => {
    capturingErrors.length = 0;
    const res = await run({
      artifactId: "artifact_1",
      code: 'return await tools.github("repo").issues.create({})',
      autoApprove: false,
    });
    // Execution is unaffected: the pause is still reported to the caller.
    expect(res.status).toBe(200);
    expect(capturingErrors.length).toBe(1);
    expect(capturingErrors[0]).toContain("simulated storage failure");
  });

  it("remains total (no 500) even when ErrorCapture is not provided", async () => {
    // oxlint-disable-next-line executor/no-double-cast -- the resulting handler is cast below to the 1-arg form the raw-web-request tests need (beta.59 ReqR inference demands a context param the runtime does not use)
    const noCaptureHandler = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(ExecutionsOnlyApi).pipe(
        Layer.provide(ExecutionsHandlers),
        Layer.provide(Layer.succeed(ExecutorService)(failingExecutor)),
        Layer.provide(Layer.succeed(ExecutionEngineService)(pausedEngine)),
        Layer.provideMerge(HttpServer.layerServices),
        Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
      ),
      { disableLogger: true },
    ).handler as unknown as (request: Request) => Promise<Response>;
    const res = await noCaptureHandler(
      new Request("https://executor.test/executions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: "artifact_1",
          code: 'return await tools.github("repo").issues.create({})',
          autoApprove: false,
        }),
      }),
    );
    expect(res.status).toBe(200);
  });
});
