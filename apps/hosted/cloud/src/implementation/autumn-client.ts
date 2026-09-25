/** Small Effect HTTP adapter for the cloud product's Autumn operations. */
import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  AutumnClient,
  AutumnRequestFailed,
  AutumnRequests,
  AutumnResponses,
  autumnApiVersion,
  autumnTimeout,
  type AutumnOptions,
} from "../contracts/autumn.ts";

/** Use the injected HTTP client. Every call owns its response scope and obeys caller cancellation. */
export const autumnLive = (options: AutumnOptions) =>
  Layer.effect(
    AutumnClient,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      // The instance path is a capability. Traces record only the host and the operation route.
      const server = URL.parse(Redacted.value(options.serverUrl));
      if (server === null) return yield* Effect.die(new Error("The Autumn server URL is invalid."));
      const post =
        <I, A>(
          operation: AutumnRequestFailed["operation"],
          path: string,
          input: Schema.Codec<I, unknown>,
          output: Schema.ConstraintDecoder<A>,
        ) =>
        (payload: I) => {
          const failed = (reason: AutumnRequestFailed["reason"], cause: unknown, status?: number) =>
            new AutumnRequestFailed({
              operation,
              reason,
              cause: Redacted.make(cause),
              ...(status === undefined ? {} : { status }),
            });
          return Effect.scoped(
            Effect.gen(function* () {
              const body = yield* Schema.encodeEffect(input)(payload).pipe(
                Effect.mapError((cause) => failed("request", cause)),
              );
              const request = yield* HttpClientRequest.post(
                `${Redacted.value(options.serverUrl).replace(/\/+$/, "")}/v1/${path}`,
              ).pipe(
                HttpClientRequest.bearerToken(options.secretKey),
                HttpClientRequest.setHeaders({
                  accept: "application/json",
                  "x-api-version": autumnApiVersion,
                }),
                HttpClientRequest.bodyJson(body),
                Effect.mapError((cause) => failed("request", cause)),
              );
              // One client span per round trip separates network and Autumn time from local work.
              const exchange = yield* Effect.gen(function* () {
                const response = yield* HttpClient.withScope(http)
                  .execute(request)
                  .pipe(Effect.mapError((cause) => failed("transport", cause)));
                yield* Effect.annotateCurrentSpan("http.response.status_code", response.status);
                // Autumn's 202 check response can represent fail-open admission. Require a confirmed result.
                if (response.status !== 200) return { status: response.status } as const;
                const json = yield* response.json.pipe(
                  Effect.mapError((cause) => failed("response", cause, response.status)),
                );
                return { status: 200, json } as const;
              }).pipe(
                Effect.withSpan("autumn.http", {
                  kind: "client",
                  attributes: {
                    "http.request.method": "POST",
                    "server.address": server.host,
                    // The route below the private instance prefix, never the full path.
                    "autumn.path": `/v1/${path}`,
                  },
                }),
              );
              yield* Effect.annotateCurrentSpan("http.response.status_code", exchange.status);
              if (exchange.status !== 200)
                return yield* new AutumnRequestFailed({
                  operation,
                  reason: "status",
                  status: exchange.status,
                });
              return yield* Schema.decodeUnknownEffect(output)(exchange.json).pipe(
                Effect.mapError((cause) => failed("response", cause, exchange.status)),
              );
            }),
          ).pipe(
            Effect.timeout(autumnTimeout),
            Effect.catchTag("TimeoutError", (cause) => Effect.fail(failed("timeout", cause))),
            // Replace the generic HTTP span: a private instance path carries a capability.
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            Effect.withSpan(`autumn.${operation}`),
          );
        };
      return AutumnClient.of({
        getOrCreateCustomer: post(
          "getOrCreateCustomer",
          "customers.get_or_create",
          AutumnRequests.getOrCreateCustomer,
          AutumnResponses.getOrCreateCustomer,
        ),
        listPlans: post(
          "listPlans",
          "plans.list",
          AutumnRequests.listPlans,
          AutumnResponses.listPlans,
        ),
        check: post("check", "balances.check", AutumnRequests.check, AutumnResponses.check),
        updateBalance: post(
          "updateBalance",
          "balances.update",
          AutumnRequests.updateBalance,
          AutumnResponses.updateBalance,
        ),
        attach: post("attach", "billing.attach", AutumnRequests.attach, AutumnResponses.attach),
        openCustomerPortal: post(
          "openCustomerPortal",
          "billing.open_customer_portal",
          AutumnRequests.openCustomerPortal,
          AutumnResponses.openCustomerPortal,
        ),
        cancelSubscription: post(
          "cancelSubscription",
          "billing.update",
          AutumnRequests.cancelSubscription,
          AutumnResponses.cancelSubscription,
        ),
      });
    }),
  );
