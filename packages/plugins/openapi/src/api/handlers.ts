import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Context, Effect } from "effect";

import { addGroup, capture } from "@executor-js/api";
import type {
  OpenApiConfiguredValueInput,
  OpenApiConfigureInput,
  OpenApiPluginExtension,
  OpenApiPreviewSpecFetchCredentialsInput,
  OpenApiSpecFetchCredentialsInput,
} from "../sdk/plugin";
import { StoredSourceSchema } from "../sdk/store";
import { OpenApiGroup } from "./group";

// ---------------------------------------------------------------------------
// Service tag
//
// Holds the `Captured` shape — every method's `StorageFailure`
// channel has been swapped for `InternalError({ traceId })`. The cloud
// app provides an already-wrapped extension via
// `Layer.succeed(OpenApiExtensionService, withCapture(executor.openapi))`.
// Handlers see `InternalError` in the error union, which matches
// `.addError(InternalError)` on the group — no per-handler translation.
// ---------------------------------------------------------------------------

export class OpenApiExtensionService extends Context.Service<
  OpenApiExtensionService,
  OpenApiPluginExtension
>()("OpenApiExtensionService") {}

// ---------------------------------------------------------------------------
// Composed API — core + openapi group
// ---------------------------------------------------------------------------

const ExecutorApiWithOpenApi = addGroup(OpenApiGroup);

// ---------------------------------------------------------------------------
// Handlers
//
// Each handler is exactly: yield the extension service, call the method,
// return. Plugin SDK errors flow through the typed channel and are
// schema-encoded to 4xx by HttpApi (see group.ts `.addError(...)` calls).
// Defects bubble up and are captured + downgraded to `InternalError(traceId)`
// by the API-level observability middleware.
// ---------------------------------------------------------------------------

export const OpenApiHandlers = HttpApiBuilder.group(ExecutorApiWithOpenApi, "openapi", (handlers) =>
  handlers
    .handle("previewSpec", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* OpenApiExtensionService;
          return yield* ext.previewSpec({
            spec: payload.spec,
            specFetchCredentials: payload.specFetchCredentials as
              | OpenApiPreviewSpecFetchCredentialsInput
              | undefined,
          });
        }),
      ),
    )
    .handle("addSpec", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* OpenApiExtensionService;
          const result = yield* ext.addSpec({
            spec: payload.spec,
            specFetchCredentials: payload.specFetchCredentials as
              | OpenApiSpecFetchCredentialsInput
              | undefined,
            scope: path.scopeId,
            name: payload.name,
            baseUrl: payload.baseUrl,
            namespace: payload.namespace,
            headers: payload.headers as Record<string, OpenApiConfiguredValueInput> | undefined,
            queryParams: payload.queryParams as
              | Record<string, OpenApiConfiguredValueInput>
              | undefined,
            oauth2: payload.oauth2,
          });
          return {
            toolCount: result.toolCount,
            namespace: result.sourceId,
          };
        }),
      ),
    )
    .handle("getSource", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* OpenApiExtensionService;
          const source = yield* ext.getSource(path.namespace, path.scopeId);
          return source
            ? StoredSourceSchema.make({
                namespace: source.namespace,
                scope: source.scope,
                name: source.name,
                config: {
                  sourceUrl: source.config.sourceUrl,
                  googleDiscoveryUrls: source.config.googleDiscoveryUrls,
                  baseUrl: source.config.baseUrl,
                  namespace: source.config.namespace,
                  headers: source.config.headers,
                  queryParams: source.config.queryParams,
                  specFetchCredentials: source.config.specFetchCredentials,
                  oauth2: source.config.oauth2,
                },
              })
            : null;
        }),
      ),
    )
    .handle("configure", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* OpenApiExtensionService;
          return yield* ext.configure(payload.source, payload as OpenApiConfigureInput);
        }),
      ),
    ),
);
