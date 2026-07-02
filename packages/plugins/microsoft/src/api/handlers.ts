import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Context, Effect } from "effect";

import { addGroup, capture } from "@executor-js/api";
import type { MicrosoftPluginExtension } from "../sdk/plugin";
import { MicrosoftGroup } from "./group";

export class MicrosoftExtensionService extends Context.Service<
  MicrosoftExtensionService,
  MicrosoftPluginExtension
>()("MicrosoftExtensionService") {}

const ExecutorApiWithMicrosoft = addGroup(MicrosoftGroup);

export const MicrosoftHandlers = HttpApiBuilder.group(
  ExecutorApiWithMicrosoft,
  "microsoft",
  (handlers) =>
    handlers
      .handle("addGraph", ({ payload }) =>
        capture(
          Effect.gen(function* () {
            const ext = yield* MicrosoftExtensionService;
            return yield* ext.addGraph({
              presetIds: payload.presetIds,
              customScopes: payload.customScopes,
              slug: payload.slug,
              name: payload.name,
              description: payload.description,
              baseUrl: payload.baseUrl,
              specUrl: payload.specUrl,
              authorizationUrl: payload.authorizationUrl,
              tokenUrl: payload.tokenUrl,
              clientCredentialsTokenUrl: payload.clientCredentialsTokenUrl,
            });
          }),
        ),
      )
      .handle("getIntegration", ({ params }) =>
        capture(
          Effect.gen(function* () {
            const ext = yield* MicrosoftExtensionService;
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
            const ext = yield* MicrosoftExtensionService;
            const config = yield* ext.getConfig(params.slug);
            return config
              ? {
                  sourceUrl: config.sourceUrl,
                  microsoftGraphPresetIds: config.microsoftGraphPresetIds
                    ? [...config.microsoftGraphPresetIds]
                    : undefined,
                  microsoftGraphCustomScopes: config.microsoftGraphCustomScopes
                    ? [...config.microsoftGraphCustomScopes]
                    : undefined,
                  microsoftGraphScopes: config.microsoftGraphScopes
                    ? [...config.microsoftGraphScopes]
                    : undefined,
                  microsoftGraphExactPaths: config.microsoftGraphExactPaths
                    ? [...config.microsoftGraphExactPaths]
                    : undefined,
                  microsoftGraphPathPrefixes: config.microsoftGraphPathPrefixes
                    ? [...config.microsoftGraphPathPrefixes]
                    : undefined,
                  microsoftGraphTagPrefixes: config.microsoftGraphTagPrefixes
                    ? [...config.microsoftGraphTagPrefixes]
                    : undefined,
                  microsoftGraphCoversFullGraph: config.microsoftGraphCoversFullGraph,
                  microsoftGraphAuthorizationUrl: config.microsoftGraphAuthorizationUrl,
                  microsoftGraphTokenUrl: config.microsoftGraphTokenUrl,
                  microsoftGraphClientCredentialsTokenUrl:
                    config.microsoftGraphClientCredentialsTokenUrl,
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
            const ext = yield* MicrosoftExtensionService;
            const authenticationTemplate = yield* ext.configure(params.slug, {
              authenticationTemplate: payload.authenticationTemplate,
              mode: payload.mode ?? "merge",
            });
            return { authenticationTemplate: [...authenticationTemplate] };
          }),
        ),
      )
      .handle("updateGraph", ({ params, payload }) =>
        capture(
          Effect.gen(function* () {
            const ext = yield* MicrosoftExtensionService;
            const result = yield* ext.updateGraph(params.slug, {
              ...(payload.presetIds !== undefined ? { presetIds: payload.presetIds } : {}),
              ...(payload.customScopes !== undefined ? { customScopes: payload.customScopes } : {}),
              ...(payload.baseUrl !== undefined ? { baseUrl: payload.baseUrl } : {}),
              ...(payload.specUrl !== undefined ? { specUrl: payload.specUrl } : {}),
              ...(payload.authorizationUrl !== undefined
                ? { authorizationUrl: payload.authorizationUrl }
                : {}),
              ...(payload.tokenUrl !== undefined ? { tokenUrl: payload.tokenUrl } : {}),
              ...(payload.clientCredentialsTokenUrl !== undefined
                ? { clientCredentialsTokenUrl: payload.clientCredentialsTokenUrl }
                : {}),
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
      .handle("removeGraph", ({ params }) =>
        capture(
          Effect.gen(function* () {
            const ext = yield* MicrosoftExtensionService;
            yield* ext.removeGraph(params.slug);
          }),
        ),
      ),
);
