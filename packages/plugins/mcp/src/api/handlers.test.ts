// ---------------------------------------------------------------------------
// Handler-level integration test for the MCP group.
//
// Verifies the layer wiring stays coherent end-to-end: the handlers
// pull the wrapped extension from the service, and any un-caught cause
// lands in the observability middleware — producing a 500 whose body is
// the opaque `InternalError` schema (no internal leakage).
// ---------------------------------------------------------------------------

import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import { addGroup, observabilityMiddleware } from "@executor-js/api";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "@executor-js/api/server";
import type { McpPluginExtension } from "../sdk/plugin";
import { McpConnectionError } from "../sdk/errors";
import { McpExtensionService, McpHandlers } from "./handlers";
import { McpGroup } from "./group";

const unused = Effect.die("unused");

const failingExtension: McpPluginExtension = {
  // oxlint-disable-next-line executor/no-error-constructor -- boundary: test injects a defect to verify opaque handler error responses
  probeEndpoint: () => Effect.die(new Error("Not implemented")),
  addSource: () => unused,
  removeSource: () => unused,
  refreshSource: () => unused,
  getSource: () => Effect.succeed(null),
  updateSource: () => unused,
  listSourceBindings: () => Effect.succeed([]),
  setSourceBinding: () => unused,
  removeSourceBinding: () => unused,
};

const Api = addGroup(McpGroup);
const UnusedExecutor = Layer.succeed(ExecutorService)({} as ExecutorService["Service"]);
const UnusedExecutionEngine = Layer.succeed(ExecutionEngineService)(
  {} as ExecutionEngineService["Service"],
);

const webHandlerFor = (extension: McpPluginExtension) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(Api).pipe(
          Layer.provide(CoreHandlers),
          Layer.provide(McpHandlers),
          Layer.provide(observabilityMiddleware(Api)),
          Layer.provide(UnusedExecutor),
          Layer.provide(UnusedExecutionEngine),
          Layer.provide(Layer.succeed(McpExtensionService, extension)),
          Layer.provideMerge(HttpServer.layerServices),
          Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
        ),
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );

// `acquireRelease` keeps disposal inside the Effect scope — no
// try/finally, no per-test cleanup plumbing. `it.scoped` closes the
// scope for us. Each `Layer.provide` satisfies a piece of the api
// builder's dependency graph; `provideMerge` at the bottom keeps
// framework services available to the router itself.
const WebHandler = webHandlerFor(failingExtension);

const McpConnectionErrorResponse = Schema.Struct({
  _tag: Schema.Literal("McpConnectionError"),
  message: Schema.String,
});

describe("McpHandlers", () => {
  it.effect("defect-returning methods produce an opaque InternalError, no leakage", () =>
    Effect.gen(function* () {
      const web = yield* WebHandler;
      const response = yield* Effect.promise(() =>
        (web.handler as (request: Request) => Promise<Response>)(
          new Request("http://localhost/scopes/scope_1/mcp/probe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ endpoint: "https://example.com/mcp" }),
          }),
        ),
      );

      expect(response.status).toBe(500);
      const body = yield* Effect.promise(() => response.text());
      expect(body).not.toContain("Not implemented");
    }),
  );

  it.effect("domain MCP connection errors are encoded as 400 responses", () =>
    Effect.gen(function* () {
      const web = yield* webHandlerFor({
        ...failingExtension,
        probeEndpoint: () =>
          Effect.fail(
            new McpConnectionError({
              transport: "remote",
              message:
                "Failed to connect to MCP endpoint and no OAuth was detected. Do you need to provide an API key, header, or query parameter?",
            }),
          ),
      });
      const response = yield* Effect.promise(() =>
        (web.handler as (request: Request) => Promise<Response>)(
          new Request("http://localhost/scopes/scope_1/mcp/probe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ endpoint: "https://ui.sh/mcp" }),
          }),
        ),
      );

      expect(response.status).toBe(400);
      const body = yield* Schema.decodeUnknownEffect(McpConnectionErrorResponse)(
        yield* Effect.promise(() => response.json()),
      );
      expect(body.message).toContain("Do you need to provide an API key");
    }),
  );
});
