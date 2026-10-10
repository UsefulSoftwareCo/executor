/** Small Effect HTTP adapter for the cloud product's Autumn operations. */
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import {
  AutumnClient,
  AutumnRequestFailed,
  AutumnRequests,
  AutumnResponses,
  autumnApiVersion,
  autumnTimeout,
  type AutumnOptions,
} from "../contracts/autumn.ts";

/** Autumn's error body; only its stable code is read. */
const NotFound = Schema.Struct({ code: Schema.String });

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
          /** A 404 with this error code is an answer, decoded as `null`, not a failure. */
          notFound?: string,
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
                // Require confirmed provider responses, never queued or fail-open answers.
                const missing = notFound !== undefined && response.status === 404;
                if (response.status !== 200 && !missing)
                  return { status: response.status, answered: false } as const;
                const json = yield* response.json.pipe(
                  Effect.mapError((cause) => failed("response", cause, response.status)),
                );
                if (!missing) return { status: 200, answered: true, json } as const;
                // Only the named code answers; any other 404, such as an unknown route, fails.
                const named = Option.exists(
                  Schema.decodeUnknownOption(NotFound)(json),
                  (body) => body.code === notFound,
                );
                return { status: 404, answered: named, json: null } as const;
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
              if (!exchange.answered)
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
        getCustomer: post(
          "getCustomer",
          "customers.get",
          AutumnRequests.getCustomer,
          AutumnResponses.getCustomer,
          "customer_not_found",
        ),
        listPlans: post(
          "listPlans",
          "plans.list",
          AutumnRequests.listPlans,
          AutumnResponses.listPlans,
        ),
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
