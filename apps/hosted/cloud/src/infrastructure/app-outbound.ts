/** Dynamic app Workers need a real Fetcher; native Workflows cannot lend their implicit network. */
import * as Cloudflare from "alchemy/Cloudflare";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Random } from "alchemy";
import { Cause, Effect, Redacted, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { recordRoute } from "@executor-js/telemetry";
import type { Fetcher } from "@cloudflare/workers-types";
import {
  credentialFetch,
  credentialKey,
  NetworkUnreachable,
  networkUnreachableResponse,
} from "@executor-js/sdk/workerd";
import { type AppEgressFailed, egressFailure } from "../implementation/app-egress.ts";
import { cloudSentry, reportCloudFailure } from "../implementation/error-reporting.ts";

export const AppOutbound = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__) return yield* Cloudflare.Worker.ref("AppOutbound");
  return yield* Cloudflare.Worker("AppOutbound", {
    workersDev: false,
    compatibility: { date: "2026-09-08", flags: ["global_fetch_strictly_public"] },
    // This private service has no application bindings or credentials.
    script: `export default {
      fetch(request) { return fetch(request); }
    };`,
  });
});

/**
 * Worker props for the Worker that serves app requests. Deployed, `AppOutbound`'s public-only
 * network refuses private, loopback and internal destinations with Cloudflare's own 403 or 530,
 * so Executor refuses them by name first and app code reads why. The local test Worker shares
 * the host's network, and scenarios reach fixtures on loopback through it.
 */
export const appOutboundBindings = Effect.gen(function* () {
  return { APPS_PRIVATE_FETCH: (yield* AlchemyContext).dev };
});

/** What the runner binds to one app's outbound network. App code cannot set it. */
const OutboundProps = Schema.Struct({ appOutbound: Schema.NonEmptyString });
/** The private network service, as the outbound sends to it. */
interface Network {
  fetch(request: Request): Promise<Response>;
}
const NativeNetwork = Schema.declare(
  (value): value is Network =>
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof value.fetch === "function",
);
type Loopback = (options: { readonly props: typeof OutboundProps.Type }) => Fetcher;
const Exports = Schema.Struct({
  exports: Schema.Struct({
    default: Schema.declare((value): value is Loopback => typeof value === "function"),
  }),
});

/**
 * Each app's outbound network, for a Worker that loads app code. The Worker's own default
 * entrypoint, specialized with the app, substitutes the credential handles a request carries and
 * sends it through the private `AppOutbound` service, which enforces public routing. Only the
 * runner creates these specializations; requests from anywhere else carry no app and are routed
 * normally. See credential-handles.ts in the SDK.
 */
export const appCredentialOutbound = Effect.gen(function* () {
  const network = yield* AppOutbound;
  const worker = yield* Cloudflare.Worker;
  yield* worker.bind`${network}`({
    bindings: [{ type: "service", name: "AppOutbound", service: network.workerName }],
  });
  const environment = yield* Cloudflare.WorkerEnvironment;
  // The runner and this Worker's outbound entrypoint share it; app code never receives it.
  const secret = yield* (yield* Random("AppCredentialKey")).text;
  const key = secret.pipe(Effect.flatMap((value) => credentialKey(Redacted.value(value))));
  const reportErrors = yield* cloudSentry;
  /** Report Executor's own egress failure; the scope flushes it before the app hears back. */
  const report = (failure: AppEgressFailed) =>
    reportCloudFailure(Cause.fail(failure)).pipe(reportErrors, Effect.scoped);
  const loopback = Effect.promise(() => import("cloudflare:workers")).pipe(
    // Loopback exports are newer than the module declarations this package uses.
    Effect.flatMap((module) => Schema.decodeUnknownEffect(Exports)(module)),
    Effect.map(({ exports }) => exports),
    Effect.orDie,
  );
  return {
    key,
    /** The network one app's isolates use for global `fetch`. */
    outbound: Effect.gen(function* () {
      const exports = yield* loopback;
      return (app: string) => exports.default({ props: { appOutbound: app } });
    }),
    /** Serve a request sent by an app's isolate, or pass any other request to `handler`. */
    serve: <E, R>(
      handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    ): Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      E,
      R | HttpServerRequest.HttpServerRequest | Cloudflare.WorkerExecutionContext
    > =>
      Effect.gen(function* () {
        const execution = yield* Cloudflare.WorkerExecutionContext;
        const props = Schema.decodeUnknownOption(OutboundProps)(execution.raw.props);
        if (props._tag === "None") return yield* handler;
        // The path is the app's request to its upstream, so its span records none of it.
        yield* recordRoute("/:upstream");
        const request = yield* HttpServerRequest.HttpServerRequest;
        const source = request.source;
        if (!(source instanceof Request)) return yield* Effect.die("App request is not a Request");
        const send = yield* Schema.decodeUnknownEffect(NativeNetwork)(environment.AppOutbound).pipe(
          Effect.orDie,
        );
        // The secret is read from this event's Worker environment.
        const sealing = yield* key;
        const privateFetch = yield* Schema.decodeUnknownEffect(Schema.Boolean)(
          environment.APPS_PRIVATE_FETCH,
        ).pipe(Effect.orDie);
        // The network's rejection, kept for the report after the app's request is answered.
        let unsent: AppEgressFailed | undefined;
        const response = yield* Effect.tryPromise({
          try: () =>
            credentialFetch(source, {
              app: props.value.appOutbound,
              key: sealing,
              // Cloud's own origin is public, so it needs no exemption.
              egress: { refusePrivateAddresses: !privateFetch, selfOrigin: undefined },
              send: (request) =>
                send.fetch(request).catch((error: unknown) => {
                  if (!source.signal.aborted) unsent = egressFailure("send", error);
                  throw error;
                }),
            }),
          catch: (error) => egressFailure("outbound", error),
        }).pipe(
          // Executor's own failure still reaches the app as a failed fetch, never as an answer
          // from the service. A request the app cancelled needs no answer.
          Effect.catch((failure) =>
            source.signal.aborted
              ? Effect.interrupt
              : report(failure).pipe(
                  Effect.as(networkUnreachableResponse(new NetworkUnreachable())),
                ),
          ),
        );
        if (unsent !== undefined) yield* report(unsent);
        return HttpServerResponse.fromWeb(response);
      }),
  };
});
