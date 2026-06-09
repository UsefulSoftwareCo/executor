import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Context, Effect } from "effect";

import { addGroup, capture } from "@executor-js/api";
import type { GraphqlPluginExtension } from "../sdk/plugin";
import { GraphqlGroup } from "./group";

// ---------------------------------------------------------------------------
// Service tag
//
// Holds the plugin's extension. The host app provides an already-wrapped
// extension via `Layer.succeed(GraphqlExtensionService, executor.graphql)`.
// Handlers see plugin SDK errors in the typed channel (matched by
// `.addError(...)` on the group) and `InternalError` for `StorageError`
// translated by `capture` at the HTTP edge.
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
// ---------------------------------------------------------------------------

export const GraphqlHandlers = HttpApiBuilder.group(ExecutorApiWithGraphql, "graphql", (handlers) =>
  handlers
    .handle("addIntegration", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* GraphqlExtensionService;
          const result = yield* ext.addIntegration({
            endpoint: payload.endpoint,
            slug: payload.slug,
            name: payload.name,
            introspectionJson: payload.introspectionJson,
            headers: payload.headers,
            queryParams: payload.queryParams,
            authenticationTemplate: payload.authenticationTemplate,
          });
          return { slug: result.slug, name: result.name };
        }),
      ),
    )
    .handle("getIntegration", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* GraphqlExtensionService;
          return yield* ext.getIntegration(path.slug);
        }),
      ),
    )
    .handle("getConfig", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* GraphqlExtensionService;
          const config = yield* ext.getConfig(path.slug);
          return config
            ? {
                endpoint: config.endpoint,
                name: config.name,
                introspectionJson: config.introspectionJson,
                headers: config.headers ? { ...config.headers } : undefined,
                queryParams: config.queryParams ? { ...config.queryParams } : undefined,
                authenticationTemplate: [...config.authenticationTemplate],
              }
            : null;
        }),
      ),
    )
    .handle("configure", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* GraphqlExtensionService;
          const authenticationTemplate = yield* ext.configureAuth(path.slug, {
            authenticationTemplate: payload.authenticationTemplate,
            mode: payload.mode ?? "merge",
          });
          return { authenticationTemplate: [...authenticationTemplate] };
        }),
      ),
    ),
);
