/**
 * Node composition edge shared by the CLI's foreground, background and private servers.
 *
 * A local server binds its port first and answers its service routes at once. It then takes its
 * data directory's lifetime lock, and only then opens storage and composes the product. Every
 * other request answers 503 until the product is ready, and again once it starts closing.
 */
import { createServer } from "node:http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ScheduleHostReady } from "@executor-js/sdk/scheduling";
import { localTelemetry, type LocalTelemetryOptions } from "@executor-js/telemetry/local";
import { Deferred, Effect, Layer, Option, Redacted, Ref, Schema, Scope } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { NetAddress } from "effect/net";
import { AuthForbidden } from "./contracts/auth.ts";
import type { ServerConfig } from "./contracts/config.ts";
import type { LocalServerOptions } from "./contracts/server.ts";
export type { LocalServerOptions, LocalWeb } from "./contracts/server.ts";
import {
  ServiceChallenge,
  ServiceFailed,
  ServiceInfo,
  serviceInfoPath,
  serviceStopPath,
} from "./contracts/service.ts";
import { StartupFailed } from "./contracts/startup.ts";
import { bearerMatches, localRequest, makeLocalAuth, pairingUrl } from "./implementation/auth.ts";
import { localApi } from "./implementation/server.ts";
import { lockDataDirectory, serviceProof, serviceVersion } from "./implementation/service-files.ts";
import { startupPhase } from "./implementation/startup-diagnostics.ts";

/**
 * The process services every request runs with: Node's platform and HTTP support, telemetry, and
 * the random IDs and digests the SDK takes from its host.
 * Build them before listening, so a failure to listen still reaches the diagnostics file.
 */
export const localServices = (directory: string, options: LocalTelemetryOptions = {}) =>
  Layer.mergeAll(
    localTelemetry(directory, "executor-local", options).pipe(Layer.provide(NodeServices.layer)),
    NodeHttpServer.layerHttpServices,
    NodeCrypto.layerSecureRandom,
    NodeCrypto.layerDigest,
  );
export type LocalServices = Layer.Success<ReturnType<typeof localServices>>;

/** The composed product's request handler, served behind the service routes. */
export type LocalHandler = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  unknown,
  HttpServerRequest.HttpServerRequest | Scope.Scope | LocalServices
>;

const noStore = { "cache-control": "no-store" };
const unavailable = () =>
  HttpServerResponse.empty({ status: 503, headers: { ...noStore, "retry-after": "1" } });
const forbidden = () => Effect.succeed(HttpServerResponse.empty({ status: 403 }));
const at = (url: string, path: string) => url === path || url.startsWith(`${path}?`);

/**
 * Listen on 127.0.0.1:`port` for the current scope and serve the service routes at once.
 * `GET /api/service` needs no credential, and proves this process knows `password` when asked with
 * a challenge; `POST /api/service/stop` needs `password` as a bearer, so a server without one
 * cannot be stopped over HTTP. Both refuse browsers.
 */
export const listenLocal = (options: {
  readonly port: number;
  readonly password: Redacted.Redacted<string> | undefined;
}) =>
  Effect.gen(function* () {
    const id = globalThis.crypto.randomUUID();
    const version = yield* serviceVersion;
    const product = yield* Ref.make(Option.none<LocalHandler>());
    const stopping = yield* Deferred.make<string>();
    /** The product started closing, however the server was ended, as by an interrupt. */
    const closing = yield* Ref.make(false);
    const socket = yield* Effect.sync(() => createServer());
    const server = yield* NodeHttpServer.make(() => socket, {
      host: "127.0.0.1",
      port: options.port,
      gracefulShutdownTimeout: 1_000,
    }).pipe(startupPhase("listen"));
    if (!NetAddress.isInetAddressV4(server.address))
      return yield* new StartupFailed({ stage: "listen" });
    const port = server.address.port;
    // The Host check refuses DNS rebinding, and every browser request carries an Origin.
    const loopback = localRequest(port).pipe(
      Effect.filterOrFail(
        (request) => request.headers.origin === undefined,
        () => new AuthForbidden(),
      ),
    );
    const info = Effect.gen(function* () {
      const request = yield* loopback;
      // A server asked to stop, which can take seconds, is going away: it is not starting again.
      const status =
        (yield* Deferred.isDone(stopping)) || (yield* Ref.get(closing))
          ? "stopping"
          : Option.isSome(yield* Ref.get(product))
            ? "ready"
            : "starting";
      const ready = status === "ready";
      const challenge = Schema.decodeUnknownOption(ServiceChallenge)(
        new URL(request.url, "http://127.0.0.1").searchParams.get("challenge"),
      );
      const proof =
        Option.isSome(challenge) && options.password !== undefined
          ? { proof: yield* serviceProof(Redacted.value(options.password), challenge.value) }
          : {};
      return HttpServerResponse.jsonUnsafe(
        ServiceInfo.make({
          id,
          version,
          pid: process.pid,
          status,
          ...proof,
        }),
        {
          status: ready ? 200 : 503,
          headers: ready ? noStore : { ...noStore, "retry-after": "1" },
        },
      );
    }).pipe(Effect.catchTag("AuthForbidden", forbidden));
    const stop = Effect.gen(function* () {
      const request = yield* loopback;
      if (!bearerMatches(request.headers.authorization, [options.password]))
        return HttpServerResponse.empty({ status: 401, headers: noStore });
      // The request's scope closes once the response is written; stopping first could drop it.
      yield* Effect.addFinalizer(() => Deferred.succeed(stopping, "stop requested"));
      return HttpServerResponse.empty({ status: 202, headers: noStore });
    }).pipe(Effect.catchTag("AuthForbidden", forbidden));
    yield* HttpServer.serveEffect(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (
          at(request.url, serviceInfoPath) &&
          (request.method === "GET" || request.method === "HEAD")
        )
          return yield* info;
        if (at(request.url, serviceStopPath) && request.method === "POST") return yield* stop;
        const handler = yield* Ref.get(product);
        return Option.isSome(handler) ? yield* handler.value : unavailable();
      }),
    ).pipe(Effect.provideService(HttpServer.HttpServer, server));
    return {
      /** Unique to this server process; a registration names it. */
      id,
      version,
      port,
      url: `http://127.0.0.1:${port}`,
      /** Serve every other request through `handler` until the current scope starts closing. */
      ready: (handler: LocalHandler) =>
        Effect.gen(function* () {
          yield* Ref.set(product, Option.some(handler));
          // Close active connections before the adapter's final shutdown. Requests receive
          // cancellation through Effect; an idle MCP stream cannot hold the process open.
          yield* Effect.addFinalizer(() =>
            Ref.set(closing, true).pipe(
              Effect.andThen(Ref.set(product, Option.none())),
              Effect.andThen(Effect.sync(() => socket.closeAllConnections())),
            ),
          );
        }),
      /** Ask this server to shut down, as the stop route does. */
      stop: (reason: string) => Deferred.succeed(stopping, reason).pipe(Effect.asVoid),
      /** Completes with the reason once something asks this server to shut down. */
      stopped: Deferred.await(stopping),
    };
  });
export type LocalListener = Effect.Success<ReturnType<typeof listenLocal>>;

/** Hold the data directory's `.server.lock` for the current scope, by the rule every holder uses. */
export { lockDataDirectory };

/**
 * Open storage and compose the product behind `listener`. The caller holds the data directory, and
 * `settings` carry its keys; the listener supplies the port.
 */
export const composeLocalServer = (
  listener: LocalListener,
  settings: ServerConfig,
  options: LocalServerOptions,
) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("Starting local server");
    yield* Effect.addFinalizer(() => Effect.logInfo("Local server stopped"));
    const config = { ...settings, port: listener.port };
    const auth = yield* makeLocalAuth(globalThis.crypto, config.directory).pipe(
      startupPhase("authentication"),
    );
    const ready = yield* Deferred.make<void>();
    const handler = yield* HttpRouter.toHttpEffect(
      localApi(config, globalThis.crypto, auth, {
        ...options,
        platform: { os: process.platform, arch: process.arch },
      }),
    ).pipe(Effect.provideService(ScheduleHostReady, Deferred.await(ready)));
    yield* listener.ready(handler);
    yield* Deferred.succeed(ready, undefined);
    yield* Effect.logInfo("Local server ready").pipe(
      Effect.annotateLogs({ url: listener.url, diagnostics: `${config.directory}/diagnostics` }),
    );
    return {
      url: listener.url,
      issuePairingLink: auth.issue().pipe(
        Effect.map(({ token, expiresAt }) => ({
          url: pairingUrl(config.browserOrigin ?? listener.url, token),
          expiresAt,
        })),
      ),
    };
  }).pipe(startupPhase("composition"));

/** Record a failed start in diagnostics: its stage and known system code, never its detail. */
export const reportStartupFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) => {
      const annotations = Schema.is(StartupFailed)(error)
        ? {
            "startup.stage": error.stage,
            ...(error.database === undefined ? {} : { "startup.database": error.database }),
            ...(error.step === undefined ? {} : { "startup.step": error.step }),
            "error.type": "StartupFailed",
            ...(error.code === undefined ? {} : { "error.code": error.code }),
          }
        : Schema.is(ServiceFailed)(error) && error.reason === "port-in-use"
          ? { "startup.stage": "listen", "error.type": "ServiceFailed", "error.code": "EADDRINUSE" }
          : Schema.is(ServiceFailed)(error) && error.reason === "directory-in-use"
            ? { "startup.stage": "lock", "error.type": "ServiceFailed" }
            : undefined;
      return annotations === undefined
        ? Effect.void
        : Effect.logError("Local server startup failed").pipe(Effect.annotateLogs(annotations));
    }),
  );

/**
 * Start one private, unregistered loopback server whose configuration is already resolved, as
 * the development entry does. It still listens first and holds the data directory's lock.
 * `stopped` completes with the reason once it must stop, as when another server took its lock.
 */
export const startLocalServer = (settings: ServerConfig, options: LocalServerOptions) =>
  Effect.gen(function* () {
    const locked = yield* Deferred.make<Scope.Scope>();
    const services = yield* Layer.build(
      localServices(settings.directory, { collectorScope: Deferred.await(locked) }),
    );
    return yield* Effect.gen(function* () {
      const listener = yield* listenLocal({ port: settings.port, password: undefined });
      const held = yield* lockDataDirectory(settings.directory, { port: listener.port });
      yield* Deferred.succeed(locked, yield* Effect.scope);
      yield* held.lost.pipe(
        Effect.andThen(listener.stop("data directory lock lost")),
        Effect.forkScoped,
      );
      const server = yield* composeLocalServer(listener, settings, options);
      return { ...server, stopped: listener.stopped };
    }).pipe(reportStartupFailure, Effect.provideContext(services));
  });
