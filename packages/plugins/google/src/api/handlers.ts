import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Context, Effect } from "effect";

import { addGroup, capture } from "@executor-js/api";
import type { GooglePluginExtension } from "../sdk/plugin";
import { GoogleGroup } from "./group";

export class GoogleExtensionService extends Context.Service<
  GoogleExtensionService,
  GooglePluginExtension
>()("GoogleExtensionService") {}

const ExecutorApiWithGoogle = addGroup(GoogleGroup);

export const GoogleHandlers = HttpApiBuilder.group(ExecutorApiWithGoogle, "google", (handlers) =>
  handlers
    .handle("addBundle", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* GoogleExtensionService;
          return yield* ext.addBundle({
            urls: payload.urls,
            slug: payload.slug,
            name: payload.name,
            description: payload.description,
            baseUrl: payload.baseUrl,
          });
        }),
      ),
    )
    .handle("getIntegration", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* GoogleExtensionService;
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
          const ext = yield* GoogleExtensionService;
          const config = yield* ext.getConfig(params.slug);
          return config
            ? {
                googleDiscoveryUrls: config.googleDiscoveryUrls
                  ? [...config.googleDiscoveryUrls]
                  : undefined,
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
          const ext = yield* GoogleExtensionService;
          const authenticationTemplate = yield* ext.configure(params.slug, {
            authenticationTemplate: payload.authenticationTemplate,
            mode: payload.mode ?? "merge",
          });
          return { authenticationTemplate: [...authenticationTemplate] };
        }),
      ),
    )
    .handle("updateBundle", ({ params, payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* GoogleExtensionService;
          const result = yield* ext.updateBundle(params.slug, {
            ...(payload.urls !== undefined ? { urls: payload.urls } : {}),
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
    .handle("removeBundle", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* GoogleExtensionService;
          yield* ext.removeBundle(params.slug);
        }),
      ),
    ),
);
