/**
 * The background Executor this desktop uses. It starts or joins the server for its data directory,
 * pairs the window with it and follows it. When the server stops answering, because it crashed or
 * another client replaced it, the desktop joins whichever server runs then, starting one if none
 * does. A server stopped on purpose, which says it is stopping until it removes its registration,
 * is not started again: the desktop says it was stopped and joins the next server that registers,
 * starting one only when asked. Quitting the desktop leaves the server running.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import {
  Clock,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Redacted,
  Ref,
  Result,
  Schema,
  Semaphore,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import type { ChildProcessSpawner } from "effect/process";
import { LocalAuthApi } from "@executor-js/local-server/auth";
import { DesktopReturnApi } from "../../../server/src/contracts/desktop-return.ts";
import { ServiceFailed, ServiceSettingInvalid } from "../../../server/src/contracts/service.ts";
import {
  discover,
  registered,
  stop,
  type RunningService,
} from "../../../server/src/implementation/service-client.ts";
import {
  readRegistration,
  refuseEarlierServer,
} from "../../../server/src/implementation/service-files.ts";
import {
  DesktopFailed,
  LocalOrigin,
  StarterDirectoryFailed,
  type DesktopRecovery,
} from "../contracts/desktop.ts";
import { ensureServer, type ServiceRuntime } from "./runtime.ts";

/**
 * Losing the server unexpectedly this many times within the window stops reconnecting and shows
 * recovery. A server that was stopped or replaced on purpose is not counted.
 */
const lossLimit = 3;
const lossWindow = Duration.seconds(60);
const reconnectDelay = Duration.millis(500);
/** How often the desktop checks that its server still answers as the registered one. */
const checkInterval = Duration.seconds(1);
/** A registered server that misses this many checks in a row is gone. */
const missedChecks = 3;
/** One wait for OAuth returns; the server answers within 20 seconds. */
const returnsTimeout = Duration.seconds(30);

/** The server, its window origin, and the one-use link that pairs the window with it. */
export interface Connected {
  readonly service: RunningService;
  readonly origin: string;
  readonly pairing: string;
}

const sameService = (left: RunningService, right: RunningService) =>
  left.pid === right.pid &&
  left.url === right.url &&
  left.version === right.version &&
  Redacted.value(left.password) === Redacted.value(right.password);

/** Recovery for a failure to start or join the server; undefined for one worth retrying. */
const recoveryFor = (error: unknown): DesktopRecovery | undefined => {
  if (Schema.is(ServiceFailed)(error)) {
    // An Executor this desktop cannot stop uses the data, so it must not be reset away.
    if (error.reason === "directory-in-use")
      return { stage: "configuration", reason: "locked", detail: error.message };
    return error.configuration === undefined
      ? { stage: "start", detail: error.message }
      : { stage: "configuration", reason: error.configuration, detail: error.detail };
  }
  if (Schema.is(ServiceSettingInvalid)(error)) return { stage: "start", detail: error.message };
  if (Schema.is(StarterDirectoryFailed)(error))
    return {
      stage: "start",
      detail:
        "Executor could not create its data directory. Check its permissions and free disk space.",
    };
  if (Schema.is(DesktopFailed)(error) && error.stage === "runtime") return { stage: "runtime" };
  return undefined;
};

/** Programmatic requests send the server's password as the bearer, and no Origin. */
const asService = (service: RunningService) => ({
  baseUrl: service.url,
  transformClient: (client: HttpClient.HttpClient) =>
    client.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(service.password))),
});

/** A one-use link that pairs a browser session with `service`. */
const pair = (service: RunningService) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(LocalAuthApi, asService(service));
    return yield* client.auth.pair().pipe(Effect.timeout(Duration.seconds(10)));
  }).pipe(
    Effect.provide(NodeHttpClient.layerNodeHttp),
    Effect.mapError(() => new DesktopFailed({ stage: "pairing" })),
  );

/**
 * A one-use link that pairs the window with `service`, on `origin`: the window always loads the
 * loopback origin, even where the server names a proxy.
 */
const windowPairing = (service: RunningService, origin: string) =>
  Effect.map(pair(service), (link) => `${origin}/${new URL(Redacted.value(link.url)).hash}`);

const desktopReturns = (service: RunningService) =>
  HttpApiClient.make(DesktopReturnApi, asService(service));

export const makeConnection = (options: {
  readonly directory: string;
  readonly runtime: ServiceRuntime;
  /** A connection attempt began; show the startup page. */
  readonly onStarting: Effect.Effect<void>;
  /**
   * The server was stopped on purpose; show that until another server registers, which the
   * desktop then joins, or `start` runs.
   */
  readonly onStopped: Effect.Effect<void>;
  readonly onReady: (connected: Connected) => Effect.Effect<void>;
  /** A provider callback the server kept for this desktop. It holds an authorization code. */
  readonly onReturn: (url: Redacted.Redacted<string>) => Effect.Effect<void>;
  /** Reconnecting stopped; show the recovery page. */
  readonly onRecovery: (recovery: DesktopRecovery) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const services = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >();
    const { directory } = options;
    const lock = yield* Semaphore.make(1);
    const following = yield* Ref.make(Option.none<Fiber.Fiber<void>>());
    const current = yield* Ref.make(Option.none<RunningService>());
    /** The first connection replaces a server of another version; later ones join any. */
    const replaced = yield* Ref.make(false);

    /**
     * Completes once `service` is gone. `stopped`: it says it is stopping, or no server is
     * registered, as when it was stopped on purpose. `replaced`: another server is registered.
     * `unanswered`: it is still registered but missed `missedChecks` checks in a row, as when it
     * crashed or hung; one slow answer does not reload the window.
     */
    const lost = (service: RunningService) =>
      Effect.gen(function* () {
        let missed = 0;
        while (missed < missedChecks) {
          yield* Effect.sleep(checkInterval);
          const found = yield* registered(directory);
          if (Option.isSome(found) && sameService(found.value, service)) {
            // A server asked to stop can take seconds to exit, and is not lost meanwhile.
            if (found.value.status === "stopping") return "stopped" as const;
            if (found.value.status === "ready") {
              missed = 0;
              continue;
            }
          } else {
            const current = yield* readRegistration(directory);
            if (Option.isNone(current)) return "stopped" as const;
            if (
              !sameService(
                { ...current.value, password: Redacted.make(current.value.password) },
                service,
              )
            )
              return "replaced" as const;
          }
          missed += 1;
        }
        return "unanswered" as const;
      });

    /** Wait for OAuth returns for as long as the server runs; `lost` decides when it is gone. */
    const returns = (service: RunningService) =>
      Effect.gen(function* () {
        const client = yield* desktopReturns(service);
        return yield* client.desktopReturns.next().pipe(
          Effect.timeout(returnsTimeout),
          Effect.flatMap(({ returns }) =>
            Effect.forEach(returns, ({ url }) => options.onReturn(url), { discard: true }),
          ),
          Effect.catch(() => Effect.sleep(checkInterval)),
          Effect.forever,
        );
      }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));

    /** Join the registered server, or start one if none runs. */
    const started = Effect.gen(function* () {
      yield* options.onStarting;
      const version = (yield* Ref.getAndSet(replaced, true)) ? "ignore" : "replace";
      const program = yield* options.runtime.program;
      yield* Effect.logInfo("Connecting to the background Executor").pipe(
        Effect.annotateLogs({ version }),
      );
      const service = yield* ensureServer(directory, {
        version,
        program,
        onStart: (start) =>
          Effect.logInfo("Starting the background Executor").pipe(
            Effect.annotateLogs({ version: start.version, previous: start.previous }),
          ),
      });
      // The server now runs this version, so other staged versions are no longer in use.
      if (version === "replace")
        yield* Effect.forkIn(options.runtime.clean(service.version), scope);
      return service;
    });

    /**
     * After a stop on purpose, wait until another server registers and answers ready, as when
     * `executor` or `executor service restart` starts one, and join it. None is started here.
     */
    const rejoined = Effect.gen(function* () {
      yield* options.onStopped;
      yield* Effect.logInfo("Waiting for the background Executor to start again");
      while (true) {
        yield* Effect.sleep(checkInterval);
        const found = yield* discover(directory);
        if (Option.isSome(found)) {
          yield* options.onStarting;
          return found.value;
        }
      }
    });

    const connect = <E, R>(join: Effect.Effect<RunningService, E, R>) =>
      Effect.gen(function* () {
        const service = yield* join;
        yield* Effect.logInfo("Background Executor ready").pipe(
          Effect.annotateLogs({ url: service.url, pid: service.pid, version: service.version }),
        );
        const origin = yield* Schema.decodeUnknownEffect(LocalOrigin)(service.url).pipe(
          Effect.mapError(() => new ServiceFailed({ reason: "unreachable", detail: service.url })),
        );
        const pairing = yield* windowPairing(service, origin);
        yield* Ref.set(current, Option.some(service));
        yield* options.onReady({ service, origin, pairing });
        const loss = yield* Effect.raceFirst(lost(service), returns(service)).pipe(
          Effect.ensuring(Ref.set(current, Option.none())),
        );
        yield* Effect.logWarning("Background Executor stopped answering").pipe(
          Effect.annotateLogs({ url: service.url, pid: service.pid, loss }),
        );
        return loss;
      });

    const follow = Effect.gen(function* () {
      let losses: ReadonlyArray<number> = [];
      while (true) {
        let outcome = yield* connect(started).pipe(Effect.result);
        // A server stopped on purpose is not started again: the next one that registers is joined.
        while (Result.isSuccess(outcome) && outcome.success === "stopped")
          outcome = yield* connect(rejoined).pipe(Effect.result);
        if (Result.isSuccess(outcome) && outcome.success === "replaced") {
          yield* Effect.sleep(reconnectDelay);
          continue;
        }
        if (Result.isFailure(outcome)) {
          const recovery = recoveryFor(outcome.failure);
          if (recovery !== undefined) {
            yield* Effect.logError("Background Executor could not start").pipe(
              Effect.annotateLogs({
                stage: recovery.stage,
                ...("reason" in recovery ? { configuration: recovery.reason } : {}),
                ...("detail" in recovery ? { detail: recovery.detail } : {}),
              }),
            );
            return yield* options.onRecovery(recovery);
          }
          yield* Effect.logWarning("Could not pair with the background Executor", outcome.failure);
        }
        const now = yield* Clock.currentTimeMillis;
        losses = [...losses.filter((at) => now - at < Duration.toMillis(lossWindow)), now];
        if (losses.length >= lossLimit) return yield* options.onRecovery({ stage: "crash-loop" });
        yield* Effect.sleep(reconnectDelay);
      }
    }).pipe(Effect.provideContext(services));

    const halt = Effect.gen(function* () {
      const fiber = yield* Ref.getAndSet(following, Option.none());
      if (Option.isSome(fiber)) yield* Fiber.interrupt(fiber.value);
    });
    const begin = Effect.gen(function* () {
      yield* halt;
      yield* Ref.set(following, Option.some(yield* Effect.forkIn(follow, scope)));
    });

    return {
      /** Start or join the server and follow it, first stopping any current attempt or wait. */
      start: lock.withPermit(begin),
      /** The server the window uses now, if any. */
      current: Ref.get(current),
      /**
       * A fresh one-use link that pairs the window with the server it uses now, as when the
       * window could not load the dashboard with the link it was given.
       */
      pairWindow: Effect.gen(function* () {
        const service = yield* Ref.get(current);
        if (Option.isNone(service)) return yield* new DesktopFailed({ stage: "pairing" });
        const origin = yield* Schema.decodeUnknownEffect(LocalOrigin)(service.value.url).pipe(
          Effect.mapError(() => new DesktopFailed({ stage: "pairing" })),
        );
        return yield* windowPairing(service.value, origin);
      }),
      /**
       * Stop the background server, run `effect` and start it again. No connection attempt runs in
       * between, so this desktop never starts a server while `effect` works on its data. While an
       * Executor from before the background service uses the data, which holds no lock and cannot
       * be stopped from here, `effect` does not run and this fails with `directory-in-use`.
       */
      whileStopped: <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | ServiceFailed | PlatformError.PlatformError, R> =>
        lock.withPermit(
          halt.pipe(
            Effect.andThen(options.onStarting),
            Effect.andThen(stop(directory).pipe(Effect.provideContext(services))),
            Effect.andThen(refuseEarlierServer(directory).pipe(Effect.provideContext(services))),
            Effect.andThen(effect),
            Effect.ensuring(begin),
          ),
        ),
      /** Ask the server to keep the callback for `state` for this desktop. */
      expectReturn: (state: string) =>
        Effect.gen(function* () {
          const service = yield* Ref.get(current);
          if (Option.isNone(service)) return yield* new DesktopFailed({ stage: "oauth" });
          const client = yield* desktopReturns(service.value);
          yield* client.desktopReturns
            .expect({ payload: { state } })
            .pipe(Effect.timeout(Duration.seconds(5)));
        }).pipe(
          Effect.provide(NodeHttpClient.layerNodeHttp),
          Effect.mapError(() => new DesktopFailed({ stage: "oauth" })),
        ),
    };
  });

export type Connection = Effect.Success<ReturnType<typeof makeConnection>>;
