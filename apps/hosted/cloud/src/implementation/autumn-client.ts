/** Small Effect HTTP adapter for the cloud product's Autumn operations. */
import { type Duration, Effect, Layer, Option, Redacted, Schedule, Schema } from "effect";
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

/**
 * How long a read may take. Writes are never retried, since a write whose answer was lost may
 * have taken, so only reads are the consumer's choice.
 */
export interface AutumnReadPolicy {
  /** Each attempt's timeout. */
  readonly attempt: Duration.Input;
  /** More attempts after a retryable failure, and the bound on all of them, waits included. */
  readonly retry?: { readonly times: number; readonly budget: Duration.Input };
}

/**
 * Each consumer picks the reads that fit its own deadline. Healthy reads answer in well under a
 * second; while Autumn is degraded some answer in up to about seven seconds and others never do.
 */
export const autumnReads = {
  /**
   * One attempt with the write timeout, for requests a person is waiting on that have their own
   * deadline: the billing overview, and sign-in's v1 check, which gives up after ten seconds.
   */
  once: { attempt: autumnTimeout },
  /**
   * The v1 import's plan check: eight seconds an attempt, then up to two more about 200 and 400
   * milliseconds apart, with jitter, within twenty seconds in all.
   */
  patient: { attempt: "8 seconds", retry: { times: 2, budget: "20 seconds" } },
} as const satisfies Record<string, AutumnReadPolicy>;

const readRetryDelay = Schedule.exponential("200 millis").pipe(Schedule.jittered);

/**
 * Whether another attempt could answer: no response, a timeout, a server error or a rate limit.
 * A response Autumn gave, an unexpected status or a body that does not decode is final.
 */
const retryable = (error: AutumnRequestFailed) =>
  error.reason === "transport" ||
  error.reason === "timeout" ||
  (error.reason === "status" &&
    error.status !== undefined &&
    (error.status >= 500 || error.status === 429));

/**
 * Use the injected HTTP client. Every call owns its response scope and obeys caller cancellation.
 * Reads follow `reads`; writes always get one attempt of `autumnTimeout`.
 */
export const autumnLive = (options: AutumnOptions, reads: AutumnReadPolicy) =>
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
          /** Reads follow the consumer's read policy; anything else is sent once. */
          kind: "read" | "write",
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
            Effect.timeout(kind === "read" ? reads.attempt : autumnTimeout),
            Effect.catchTag("TimeoutError", (cause) => Effect.fail(failed("timeout", cause))),
            (attempt) =>
              kind === "write" || reads.retry === undefined
                ? attempt
                : attempt.pipe(
                    Effect.retry({
                      times: reads.retry.times,
                      schedule: readRetryDelay,
                      while: retryable,
                    }),
                    Effect.timeout(reads.retry.budget),
                    Effect.catchTag("TimeoutError", (cause) =>
                      Effect.fail(failed("timeout", cause)),
                    ),
                  ),
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
          "write",
        ),
        getCustomer: post(
          "getCustomer",
          "customers.get",
          AutumnRequests.getCustomer,
          AutumnResponses.getCustomer,
          "read",
          "customer_not_found",
        ),
        getCustomerPlans: post(
          "getCustomerPlans",
          "customers.get",
          AutumnRequests.getCustomerPlans,
          AutumnResponses.getCustomerPlans,
          "read",
          "customer_not_found",
        ),
        listPlans: post(
          "listPlans",
          "plans.list",
          AutumnRequests.listPlans,
          AutumnResponses.listPlans,
          "read",
        ),
        updateBalance: post(
          "updateBalance",
          "balances.update",
          AutumnRequests.updateBalance,
          AutumnResponses.updateBalance,
          "write",
        ),
        attach: post(
          "attach",
          "billing.attach",
          AutumnRequests.attach,
          AutumnResponses.attach,
          "write",
        ),
        // A preview changes nothing, so it is retried like a read.
        previewAttach: post(
          "previewAttach",
          "billing.preview_attach",
          AutumnRequests.previewAttach,
          AutumnResponses.previewAttach,
          "read",
        ),
        openCustomerPortal: post(
          "openCustomerPortal",
          "billing.open_customer_portal",
          AutumnRequests.openCustomerPortal,
          AutumnResponses.openCustomerPortal,
          "write",
        ),
        updateSubscription: post(
          "updateSubscription",
          "billing.update",
          AutumnRequests.updateSubscription,
          AutumnResponses.updateSubscription,
          "write",
        ),
        renameCustomer: post(
          "renameCustomer",
          "customers.update",
          AutumnRequests.renameCustomer,
          AutumnResponses.renameCustomer,
          "write",
        ),
        deleteCustomer: post(
          "deleteCustomer",
          "customers.delete",
          AutumnRequests.deleteCustomer,
          AutumnResponses.deleteCustomer,
          "write",
        ),
        verifyBilling: post(
          "verifyBilling",
          "billing.verify",
          AutumnRequests.verifyBilling,
          AutumnResponses.verifyBilling,
          "read",
        ),
      });
    }),
  );
