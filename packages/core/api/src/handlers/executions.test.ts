import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { ExecutorApi } from "../api";
import { CoreHandlers } from ".";
import { AuthContext } from "../server/identity";
import { ExecutionEngineService, ExecutorService } from "../services";

describe("execution HTTP handler authorization", () => {
  it("does not let a delegated caller waive a required approval", async () => {
    let receivedAutoApprove: boolean | undefined;
    const engine: ExecutionEngineService["Service"] = {
      execute: () => Effect.die("unused"),
      executeWithPause: (_code, options) =>
        Effect.sync(() => {
          receivedAutoApprove = options?.autoApprove;
          return {
            status: "completed" as const,
            result: { result: { ok: true }, logs: [] },
          };
        }),
      resume: () => Effect.die("unused"),
      getPausedExecution: () => Effect.succeed(null),
      pausedExecutionCount: () => Effect.succeed(0),
      hasPausedExecutions: () => Effect.succeed(false),
      getDescription: Effect.succeed(""),
      shutdown: Effect.void,
    };
    const app = HttpApiBuilder.layer(ExecutorApi).pipe(
      Layer.provide(CoreHandlers),
      Layer.provide(Layer.succeed(ExecutorService, {} as ExecutorService["Service"])),
      Layer.provide(Layer.succeed(ExecutionEngineService, engine)),
      Layer.provide(
        Layer.succeed(AuthContext, {
          kind: "delegated",
          accountId: "target",
          organizationId: "tenant",
          email: "",
          name: null,
          avatarUrl: null,
          roles: [],
        }),
      ),
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
    );
    const web = HttpRouter.toWebHandler(app, { disableLogger: true });
    const handlerContext = Context.make(ExecutorService, {} as ExecutorService["Service"]).pipe(
      Context.add(ExecutionEngineService, engine),
    );
    const response = await web.handler(
      new Request("http://test.local/executions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "return 1", autoApprove: true }),
      }),
      handlerContext,
    );
    expect(response.status).toBe(200);
    expect(receivedAutoApprove).toBe(false);
    await web.dispose();
  });
});
