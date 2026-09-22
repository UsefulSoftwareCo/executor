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
              const response = yield* HttpClient.withScope(http)
                .execute(request)
                .pipe(Effect.mapError((cause) => failed("transport", cause)));
              yield* Effect.annotateCurrentSpan("http.response.status_code", response.status);
              // Autumn's 202 check response can represent fail-open admission. Require a confirmed result.
              if (response.status !== 200)
                return yield* new AutumnRequestFailed({
                  operation,
                  reason: "status",
                  status: response.status,
                });
              return yield* response.json.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(output)),
                Effect.mapError((cause) => failed("response", cause, response.status)),
              );
            }),
          ).pipe(
            Effect.timeout(autumnTimeout),
            Effect.catchTag("TimeoutError", (cause) => Effect.fail(failed("timeout", cause))),
            // Emit only the operation span: a private instance path carries a capability.
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
