import { localSourceFormatter } from "@executor-js/app-management/source-format";
import {
  LocalAppAccess,
  LocalAppManagementApi,
  LocalFrameworkApi,
} from "../contracts/app-management.ts";
import { DashboardAccess } from "../contracts/dashboard.ts";
import { dashboardAccess } from "./dashboard.ts";
/** Local authoring shares pairing, persistent app IDs, and the ordinary Git source store. */
import {
  AppIdentity,
  AppGitAccess,
  AppGitOrigins,
  AppAccessDenied,
  AppManagementHost,
  appManagementRoutes,
  frameworkDocumentation,
  frameworkRoutes,
  gitRoutes,
} from "@executor-js/app-management";
import { OwnerId, type AppId, type Executor } from "@executor-js/sdk/core";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { Effect, Layer, Redacted } from "effect";
import { Base64 } from "effect/encoding";
import { localRequest, requestOrigin, type LocalAuth } from "./auth.ts";
import type { ServerConfig } from "../contracts/config.ts";

/** Local has one real owner and no invented publishing organization. */
export const localAppManagement = (
  config: ServerConfig,
  auth: LocalAuth,
  managedApp: AppId,
  resources: { readonly executor: Executor },
  /** Packaged authoring assets; they include this build's framework reference. */
  assets: readonly { readonly path: string; readonly content: string }[],
) =>
  Effect.gen(function* () {
    const access = Layer.effect(
      LocalAppAccess,
      Effect.map(
        DashboardAccess,
        (authorize) => (response, options) =>
          authorize(
            response.pipe(
              Effect.provideService(AppIdentity, {
                owner: OwnerId.make("local"),
                readOwner: null,
                scope: "local",
                namespace: null,
                canWrite: true,
                protectedApps: [managedApp],
              }),
            ),
            options,
          ),
      ),
    ).pipe(Layer.provide(dashboardAccess(config, auth)));
    const gitAccess = Layer.succeed(
      AppGitAccess,
      AppGitAccess.of({
        authenticate: (request, scope) =>
          Effect.gen(function* () {
            yield* localRequest(config.port, config.browserOrigin).pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, request),
            );
            if (scope !== "local" || request.headers.origin !== undefined)
              return yield* new AppAccessDenied({ reason: "forbidden" });
            const authorization = request.headers.authorization;
            if (authorization !== `Bearer ${Redacted.value(config.apiKey)}`) {
              if (!authorization?.startsWith("Basic "))
                return yield* new AppAccessDenied({ reason: "authentication" });
              const decoded = yield* Effect.fromResult(Base64.decodeString(authorization.slice(6)));
              const colon = decoded.indexOf(":");
              if (colon < 0 || decoded.slice(colon + 1) !== Redacted.value(config.apiKey))
                return yield* new AppAccessDenied({ reason: "authentication" });
            }
            return {
              owner: OwnerId.make("local"),
              readOwner: null,
              scope: "local",
              namespace: null,
              canWrite: true,
              protectedApps: [managedApp],
            };
          }).pipe(Effect.mapError(() => new AppAccessDenied({ reason: "forbidden" }))),
      }),
    );
    return Layer.mergeAll(
      appManagementRoutes(LocalAppManagementApi),
      frameworkRoutes(LocalFrameworkApi).pipe(
        Layer.provide(frameworkDocumentation(Effect.succeed(assets))),
      ),
      gitRoutes,
    ).pipe(
      Layer.provide(access),
      HttpRouter.provideRequest(localSourceFormatter),
      HttpRouter.provideRequest(gitAccess),
      // Local serves Git on each origin it accepts; remotes name the one the client called.
      HttpRouter.provideRequest(
        Layer.succeed(AppGitOrigins, (request) => [requestOrigin(config, request)]),
      ),
      HttpRouter.provideRequest(Layer.succeed(AppManagementHost, Effect.succeed(resources))),
    );
  });
