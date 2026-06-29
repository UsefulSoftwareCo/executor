import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Context, Effect } from "effect";

import { addGroup, capture } from "@executor-js/api";
import type { OpenApiPluginExtension } from "../sdk/plugin";
import { specPreviewSummary } from "../sdk/preview";
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
// schema-encoded to 4xx by HttpApi (see group.ts errors). Defects bubble up
// and are captured + downgraded to `InternalError(traceId)` by the API-level
// observability middleware.
// ---------------------------------------------------------------------------

export const OpenApiHandlers = HttpApiBuilder.group(ExecutorApiWithOpenApi, "openapi", (handlers) =>
  handlers
    .handle("previewSpec", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* OpenApiExtensionService;
          const preview = yield* ext.previewSpec({ spec: payload.spec });
          return specPreviewSummary(preview);
        }),
      ),
    )
    .handle("addSpec", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* OpenApiExtensionService;
          return yield* ext.addSpec({
            spec: payload.spec,
            slug: payload.slug,
            name: payload.name,
            description: payload.description,
            baseUrl: payload.baseUrl,
            headers: payload.headers ? { ...payload.headers } : undefined,
            queryParams: payload.queryParams ? { ...payload.queryParams } : undefined,
            authenticationTemplate: payload.authenticationTemplate,
          });
        }),
      ),
    )
    .handle("getIntegration", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* OpenApiExtensionService;
          const integration = yield* ext.getIntegration(params.slug);
          return integration
            ? {
                slug: integration.slug,
                description: integration.description,
                kind: integration.kind,
                canRemove: integration.canRemove,
                canRefresh: integration.canRefresh,
              }
            : null;
        }),
      ),
    )
    .handle("getConfig", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* OpenApiExtensionService;
          const config = yield* ext.getConfig(params.slug);
          return config
            ? {
                sourceUrl: config.sourceUrl,
                baseUrl: config.baseUrl,
                headers: config.headers ? { ...config.headers } : undefined,
                queryParams: config.queryParams ? { ...config.queryParams } : undefined,
                authenticationTemplate: config.authenticationTemplate
                  ? [...config.authenticationTemplate]
                  : undefined,
              }
            : null;
        }),
      ),
    )
    .handle("configure", ({ params, payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* OpenApiExtensionService;
          const authenticationTemplate = yield* ext.configure(params.slug, {
            authenticationTemplate: payload.authenticationTemplate,
            mode: payload.mode ?? "merge",
          });
          return { authenticationTemplate: [...authenticationTemplate] };
        }),
      ),
    )
    .handle("updateSpec", ({ params, payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* OpenApiExtensionService;
          const result = yield* ext.updateSpec(params.slug, {
            ...(payload.spec !== undefined ? { spec: payload.spec } : {}),
          });
          return {
            slug: result.slug,
            toolCount: result.toolCount,
            addedTools: [...result.addedTools],
            removedTools: [...result.removedTools],
          };
        }),
      ),
    )
    .handle("removeSpec", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* OpenApiExtensionService;
          yield* ext.removeSpec(params.slug);
        }),
      ),
    ),
);
