/** Reuse local pairing sessions for secret exchange; link generation does not reveal setup fields. */
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpServerResponse } from "effect/http";
import type { Executor } from "@executor-js/sdk/core";
import type { ServerConfig } from "../contracts/config.ts";
import { LocalWebhookSetupApi, WebhookSetupAccess } from "../contracts/webhook-setup.ts";
import { AuthForbidden, PairingUnauthorized } from "../contracts/auth.ts";
import { DashboardUnauthorized } from "../contracts/dashboard.ts";
import { localBearer, localRequest, requestOrigin, sessionCookie, type LocalAuth } from "./auth.ts";
/** Each secret operation requires a current paired dashboard session and same-origin writes. */
export const localWebhookSetupHandlers = (
  executor: Executor,
  config: ServerConfig,
  auth: LocalAuth,
  wakeWebhookSources: Effect.Effect<void>,
) => {
  const access = Layer.succeed(WebhookSetupAccess, (response) =>
    Effect.gen(function* () {
      const request = yield* localRequest(config.port, config.browserOrigin);
      if (request.headers.authorization !== undefined) return yield* new DashboardUnauthorized();
      if (
        request.method !== "GET" &&
        (request.headers.origin === undefined ||
          new URL(request.headers.origin).host !== request.headers.host)
      )
        return yield* new AuthForbidden();
      if (!(yield* auth.valid(request.cookies[sessionCookie(config)])))
        return yield* new DashboardUnauthorized();
      return (yield* response).pipe(HttpServerResponse.setHeader("cache-control", "no-store"));
    }),
  );
  return Layer.mergeAll(
    HttpApiBuilder.group(LocalWebhookSetupApi, "webhookLinks", (handlers) =>
      handlers.handle("link", ({ params }) =>
        Effect.gen(function* () {
          const request = yield* localRequest(config.port, config.browserOrigin);
          if (
            request.headers.origin !== undefined ||
            !localBearer(config, request.headers.authorization)
          )
            return yield* new PairingUnauthorized();
          yield* executor.webhookSetup.read(params);
          return {
            url: new URL(
              `/webhooks/${encodeURIComponent(params.app)}/${encodeURIComponent(params.subscription)}`,
              config.browserOrigin ?? requestOrigin(config, request),
            ).href,
          };
        }),
      ),
    ),
    HttpApiBuilder.group(LocalWebhookSetupApi, "webhookSetup", (handlers) =>
      handlers
        .handle("read", ({ params }) => executor.webhookSetup.read(params))
        // A finished setup is new intent for the webhook source waiting on it.
        .handle("complete", ({ params, payload }) =>
          executor.webhookSetup
            .complete({ ...params, ...payload })
            .pipe(Effect.tap(() => wakeWebhookSources)),
        )
        .handle("remove", ({ params }) => executor.webhooks.remove(params))
        .handle("confirmRemoval", ({ params }) => executor.webhooks.confirmRemoval(params)),
    ),
  ).pipe(Layer.provide(access));
};
