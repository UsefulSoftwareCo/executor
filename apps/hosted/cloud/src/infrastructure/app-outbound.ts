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
  HostApiCheck,
  NetworkUnreachable,
  networkUnreachableResponse,
  outboundGroupHeader,
} from "@executor-js/sdk/workerd";
import { type AppEgressFailed, egressFailure } from "../implementation/app-egress.ts";
import { type RelayObjects, relayed, relayScript } from "../implementation/app-outbound-relay.ts";
import { appOutboundRoutes, type Sent } from "../implementation/app-outbound-routes.ts";
import { cloudSentry, reportCloudFailure } from "../implementation/error-reporting.ts";
import { platformObservability } from "./telemetry.ts";

export const AppOutbound = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__) return yield* Cloudflare.Worker.ref("AppOutbound");
  return yield* Cloudflare.Worker("AppOutbound", {
    workersDev: false,
    compatibility: {
      date: "2026-09-08",
      flags: ["global_fetch_strictly_public", "no_brotli_content_encoding"],
    },
    // This private service has no application bindings or credentials.
    script: `export default {
      fetch(request) { return fetch(request); }
    };`,
    ...(yield* platformObservability),
  });
});

/**
 * The relay's own Worker, with `AppOutbound`'s flags and no bindings or credentials besides its
 * objects. It is a Worker of its own so that removing it is the last step of a deploy that stops
 * using it: Alchemy deletes a removed Worker, and its class with it, after updating the Workers
 * that bound it, so a plain revert never deletes the class while AppData still sends to it.
 */
export const AppOutboundRelay = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__) return yield* Cloudflare.Worker.ref("AppOutboundRelay");
  return yield* Cloudflare.Worker("AppOutboundRelay", {
    workersDev: false,
    compatibility: {
      date: "2026-09-08",
      flags: ["global_fetch_strictly_public", "no_brotli_content_encoding"],
    },
    script: relayScript,
    env: { AppOutboundRelay: Cloudflare.DurableObject("AppOutboundRelay") },
    ...(yield* platformObservability),
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
const OutboundProps = Schema.Struct({
  appOutbound: Schema.NonEmptyString,
  hostApi: Schema.optionalKey(HostApiCheck),
});
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
const NativeRelayObjects = Schema.declare(
  (value): value is RelayObjects =>
    typeof value === "object" &&
    value !== null &&
    "idFromName" in value &&
    typeof value.idFromName === "function" &&
    "get" in value &&
    typeof value.get === "function",
);

/** The routes of this isolate's app requests; see `app-outbound-routes.ts`. */
const routes = appOutboundRoutes();

/** `request` without the group's name, with its body, signal and redirect mode. */
const withoutGroup = (request: Request) => {
  const headers = new Headers(request.headers);
  headers.delete(outboundGroupHeader);
  return new Request(request, { headers });
};

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
  const relay = yield* AppOutboundRelay;
  const worker = yield* Cloudflare.Worker;
  yield* worker.bind`${network}`({
    bindings: [{ type: "service", name: "AppOutbound", service: network.workerName }],
  });
  yield* worker.bind`${relay}`({
    bindings: [
      {
        type: "durable_object_namespace",
        name: "AppOutboundRelay",
        className: "AppOutboundRelay",
        scriptName: relay.workerName,
      },
    ],
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
    /**
     * Count the app requests of calls naming `group` against one incoming request, for as long as
     * the scope; see `app-outbound-routes.ts`.
     */
    outboundGroup: (group: string) =>
      Effect.acquireRelease(
        Effect.sync(() => routes.hold(group)),
        (release) => Effect.sync(release),
      ).pipe(Effect.asVoid),
    /** The network one app's isolates use for global `fetch`. */
    outbound: Effect.gen(function* () {
      const exports = yield* loopback;
      return (app: string, hostApi: HostApiCheck | undefined) =>
        exports.default({
          props: hostApi === undefined ? { appOutbound: app } : { appOutbound: app, hostApi },
        });
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
        // Which app sent it, so its route can be read with the app's other spans.
        yield* Effect.annotateCurrentSpan("executor.app.id", props.value.appOutbound);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const received = request.source;
        if (!(received instanceof Request))
          return yield* Effect.die("App request is not a Request");
        // The group the runner named for the call's incoming request goes no further.
        const group = received.headers.get(outboundGroupHeader);
        const source = group === null ? received : withoutGroup(received);
        const network = yield* Schema.decodeUnknownEffect(NativeNetwork)(
          environment.AppOutbound,
        ).pipe(Effect.orDie);
        const relay = yield* Schema.decodeUnknownEffect(NativeRelayObjects)(
          environment.AppOutboundRelay,
        ).pipe(Effect.orDie);
        // How each request was sent, for the span once the app's request is answered.
        const sent: Array<Sent> = [];
        const transport = {
          direct: (request: Request) => network.fetch(request),
          relay: (slot: number, request: Request) => relayed(relay, slot, request),
        };
        const send = (request: Request) => routes.send(group, request, transport, sent);
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
              ...(props.value.hostApi === undefined ? {} : { hostApi: props.value.hostApi }),
              key: sealing,
              // Cloud's own origin is public, so it needs no exemption.
              egress: { refusePrivateAddresses: !privateFetch, selfOrigin: undefined },
              send: (request) =>
                send(request).catch((error: unknown) => {
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
        const last = sent.at(-1);
        if (last !== undefined)
          yield* Effect.annotateCurrentSpan(
            Object.fromEntries(
              Object.entries(last).map(([name, value]) => [`executor.outbound.${name}`, value]),
            ),
          );
        if (unsent !== undefined) yield* report(unsent);
        return HttpServerResponse.fromWeb(response);
      }),
  };
});
