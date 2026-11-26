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
    script: `export default {
      fetch(request) { return fetch(request); }
    };`,
    ...(yield* platformObservability),
  });
});

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

export const appOutboundBindings = Effect.gen(function* () {
  return { APPS_PRIVATE_FETCH: (yield* AlchemyContext).dev };
});

const OutboundProps = Schema.Struct({
  appOutbound: Schema.NonEmptyString,
  hostApi: Schema.optionalKey(HostApiCheck),
});
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

const routes = appOutboundRoutes();

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
  const secret = yield* (yield* Random("AppCredentialKey")).text;
  const key = secret.pipe(Effect.flatMap((value) => credentialKey(Redacted.value(value))));
  const reportErrors = yield* cloudSentry;
  const report = (failure: AppEgressFailed) =>
    reportCloudFailure(Cause.fail(failure)).pipe(reportErrors, Effect.scoped);
  const loopback = Effect.promise(() => import("cloudflare:workers")).pipe(
    Effect.flatMap((module) => Schema.decodeUnknownEffect(Exports)(module)),
    Effect.map(({ exports }) => exports),
    Effect.orDie,
  );
  return {
    key,
    outboundGroup: (group: string) =>
      Effect.acquireRelease(
        Effect.sync(() => routes.hold(group)),
        (release) => Effect.sync(release),
      ).pipe(Effect.asVoid),
    outbound: Effect.gen(function* () {
      const exports = yield* loopback;
      return (app: string, hostApi: HostApiCheck | undefined) =>
        exports.default({
          props: hostApi === undefined ? { appOutbound: app } : { appOutbound: app, hostApi },
        });
    }),
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
        yield* recordRoute("/:upstream");
        yield* Effect.annotateCurrentSpan("executor.app.id", props.value.appOutbound);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const received = request.source;
        if (!(received instanceof Request))
          return yield* Effect.die("App request is not a Request");
        const group = received.headers.get(outboundGroupHeader);
        const source = group === null ? received : withoutGroup(received);
        const network = yield* Schema.decodeUnknownEffect(NativeNetwork)(
          environment.AppOutbound,
        ).pipe(Effect.orDie);
        const relay = yield* Schema.decodeUnknownEffect(NativeRelayObjects)(
          environment.AppOutboundRelay,
        ).pipe(Effect.orDie);
        const sent: Array<Sent> = [];
        const transport = {
          direct: (request: Request) => network.fetch(request),
          relay: (slot: number, request: Request) => relayed(relay, slot, request),
        };
        const send = (request: Request) => routes.send(group, request, transport, sent);
        const sealing = yield* key;
        const privateFetch = yield* Schema.decodeUnknownEffect(Schema.Boolean)(
          environment.APPS_PRIVATE_FETCH,
        ).pipe(Effect.orDie);
        let unsent: AppEgressFailed | undefined;
        const response = yield* Effect.tryPromise({
          try: () =>
            credentialFetch(source, {
              app: props.value.appOutbound,
              ...(props.value.hostApi === undefined ? {} : { hostApi: props.value.hostApi }),
              key: sealing,
              egress: { refusePrivateAddresses: !privateFetch, selfOrigin: undefined },
              send: (request) =>
                send(request).catch((error: unknown) => {
                  if (!source.signal.aborted) unsent = egressFailure("send", error);
                  throw error;
                }),
            }),
          catch: (error) => egressFailure("outbound", error),
        }).pipe(
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
        // external: workerd needs the native Response to keep its WebSocket attached.
        if (response.status === 101) return HttpServerResponse.raw(response, { status: 101 });
        return HttpServerResponse.fromWeb(response);
      }),
  };
});
