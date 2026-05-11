import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Context, Effect } from "effect";

import { addGroup, capture } from "@executor-js/api";
import { ScopeId } from "@executor-js/sdk/core";
import type { GraphqlPluginExtension, GraphqlUpdateSourceInput } from "../sdk/plugin";
import { GraphqlSourceBindingInput } from "../sdk/types";
import { GraphqlGroup } from "./group";

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
    .handle("addSource", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* GraphqlExtensionService;
          const result = yield* ext.addSource({
            endpoint: payload.endpoint,
            scope: payload.targetScope,
            name: payload.name,
            introspectionJson: payload.introspectionJson,
            namespace: payload.namespace,
            headers: payload.headers,
            queryParams: payload.queryParams,
            credentialTargetScope: payload.credentialTargetScope,
            auth: payload.auth,
          });
          return {
            toolCount: result.toolCount,
            namespace: result.namespace,
          };
        }),
      ),
    )
    .handle("getSource", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* GraphqlExtensionService;
          const source = yield* ext.getSource(path.namespace, path.scopeId);
          return source ? { ...source, scope: ScopeId.make(source.scope) } : null;
        }),
      ),
    )
    .handle("updateSource", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* GraphqlExtensionService;
          yield* ext.updateSource(path.namespace, payload.sourceScope, {
            name: payload.name,
            endpoint: payload.endpoint,
            headers: payload.headers,
            queryParams: payload.queryParams,
            credentialTargetScope: payload.credentialTargetScope,
            auth: payload.auth,
          } as GraphqlUpdateSourceInput);
          return { updated: true };
        }),
      ),
    )
    .handle("listSourceBindings", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* GraphqlExtensionService;
          return yield* ext.listSourceBindings(path.namespace, path.sourceScopeId);
        }),
      ),
    )
    .handle("setSourceBinding", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* GraphqlExtensionService;
          return yield* ext.setSourceBinding(new GraphqlSourceBindingInput(payload));
        }),
      ),
    )
    .handle("removeSourceBinding", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* GraphqlExtensionService;
          yield* ext.removeSourceBinding(
            payload.sourceId,
            payload.sourceScope,
            payload.slot,
            payload.scope,
          );
          return { removed: true };
        }),
      ),
    ),
);
