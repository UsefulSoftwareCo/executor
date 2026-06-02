import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Context, Effect } from "effect";

import { addGroup, capture } from "@executor-js/api";
import { ScopeId } from "@executor-js/sdk/core";
import type { GraphqlPluginExtension } from "../sdk/plugin";
import { type AddSourcePayload, GraphqlGroup } from "./group";

// ---------------------------------------------------------------------------
// Service tag
//
// Holds the `Captured` shape — every method's `StorageError` channel has
// been swapped for `InternalError({ traceId })`. The host app provides an
// already-wrapped extension via
// `Layer.succeed(GraphqlExtensionService, withCapture(executor.graphql))`.
// Handlers see `InternalError` in the error union, which matches
// `.addError(InternalError)` on the group — no per-handler translation.
// ---------------------------------------------------------------------------

export class GraphqlExtensionService extends Context.Service<
  GraphqlExtensionService,
  GraphqlPluginExtension
>()("GraphqlExtensionService") {}

// ---------------------------------------------------------------------------
// Composed API — core + graphql group
// ---------------------------------------------------------------------------

const ExecutorApiWithGraphql = addGroup(GraphqlGroup);

// ---------------------------------------------------------------------------
// Handlers
//
// Each handler is exactly: yield the extension service, call the method,
// return. Plugin SDK errors flow through the typed channel and are
// schema-encoded to 4xx by HttpApi (see group.ts `.addError(...)` calls).
// Defects bubble up and are captured + downgraded to `InternalError(traceId)`
// by the API-level observability middleware.
// ---------------------------------------------------------------------------

export const GraphqlHandlers = HttpApiBuilder.group(ExecutorApiWithGraphql, "graphql", (handlers) =>
  handlers
    .handle(
      "addSource",
      Effect.fn("graphql.addSource")(function* (ctx: {
        params: { scopeId: typeof ScopeId.Type };
        payload: typeof AddSourcePayload.Type;
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const ext = yield* GraphqlExtensionService;
            const result = yield* ext.addSource({
              endpoint: ctx.payload.endpoint,
              scope: ctx.params.scopeId,
              name: ctx.payload.name,
              introspectionJson: ctx.payload.introspectionJson,
              namespace: ctx.payload.namespace,
              headers: ctx.payload.headers,
              queryParams: ctx.payload.queryParams,
              oauth2: ctx.payload.oauth2,
              credentials: ctx.payload.credentials,
            });
            return {
              toolCount: result.toolCount,
              namespace: result.namespace,
            };
          }),
        );
      }),
    )
    .handle(
      "getSource",
      Effect.fn("graphql.getSource")(function* (ctx: {
        params: { scopeId: typeof ScopeId.Type; namespace: string };
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const ext = yield* GraphqlExtensionService;
            const source = yield* ext.getSource(ctx.params.namespace, ctx.params.scopeId);
            return source ? { ...source, scope: ScopeId.make(source.scope) } : null;
          }),
        );
      }),
    ),
);
