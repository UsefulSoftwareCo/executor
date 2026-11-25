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

const lossLimit = 3;
const lossWindow = Duration.seconds(60);
const reconnectDelay = Duration.millis(500);
const checkInterval = Duration.seconds(1);
const missedChecks = 3;
const returnsTimeout = Duration.seconds(30);

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

const recoveryFor = (error: unknown): DesktopRecovery | undefined => {
  if (Schema.is(ServiceFailed)(error)) {
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

const asService = (service: RunningService) => ({
  baseUrl: service.url,
  transformClient: (client: HttpClient.HttpClient) =>
    client.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(service.password))),
});

const pair = (service: RunningService) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(LocalAuthApi, asService(service));
    return yield* client.auth.pair().pipe(Effect.timeout(Duration.seconds(10)));
  }).pipe(
    Effect.provide(NodeHttpClient.layerNodeHttp),
    Effect.mapError(() => new DesktopFailed({ stage: "pairing" })),
  );

const windowPairing = (service: RunningService, origin: string) =>
  Effect.map(pair(service), (link) => `${origin}/${new URL(Redacted.value(link.url)).hash}`);

const desktopReturns = (service: RunningService) =>
  HttpApiClient.make(DesktopReturnApi, asService(service));

export const makeConnection = (options: {
  readonly directory: string;
  readonly runtime: ServiceRuntime;
  readonly onStarting: Effect.Effect<void>;
  readonly onStopped: Effect.Effect<void>;
  readonly onReady: (connected: Connected) => Effect.Effect<void>;
  readonly onReturn: (url: Redacted.Redacted<string>) => Effect.Effect<void>;
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
    const replaced = yield* Ref.make(false);

    const lost = (service: RunningService) =>
      Effect.gen(function* () {
        let missed = 0;
        while (missed < missedChecks) {
          yield* Effect.sleep(checkInterval);
          const found = yield* registered(directory);
          if (Option.isSome(found) && sameService(found.value, service)) {
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
      if (version === "replace")
        yield* Effect.forkIn(options.runtime.clean(service.version), scope);
      return service;
    });

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
      start: lock.withPermit(begin),
      current: Ref.get(current),
      pairWindow: Effect.gen(function* () {
        const service = yield* Ref.get(current);
        if (Option.isNone(service)) return yield* new DesktopFailed({ stage: "pairing" });
        const origin = yield* Schema.decodeUnknownEffect(LocalOrigin)(service.value.url).pipe(
          Effect.mapError(() => new DesktopFailed({ stage: "pairing" })),
        );
        return yield* windowPairing(service.value, origin);
      }),
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
