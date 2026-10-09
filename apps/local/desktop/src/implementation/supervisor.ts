/** Keeps one backend running: restarts it with backoff and stops after a crash loop. */
import { Clock, Duration, Effect, Fiber, Option, Redacted, Ref, Scope, Semaphore } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { DesktopBootstrap } from "@executor-js/local-server/auth";
import type { DesktopFailed, DesktopRecovery } from "../contracts/desktop.ts";
import { classifyBackendExit, type BackendExit, type BackendRun } from "./backend.ts";

/** Restart delays start here and double after each unexpected exit. Readiness resets them. */
const initialDelay = Duration.millis(500);
const maximumDelay = Duration.seconds(10);
/** This many unexpected exits inside the window stop supervision and show recovery. */
const crashLoopExits = 3;
const crashLoopWindow = Duration.seconds(60);
const readyTimeout = Duration.seconds(60);

export const restartDelay = (attempt: number) =>
  Duration.min(Duration.times(initialDelay, 2 ** attempt), maximumDelay);

type Token = (typeof DesktopBootstrap.Type)["token"];
type Outcome =
  | { readonly kind: "stopped" }
  | { readonly kind: "recover"; readonly recovery: DesktopRecovery }
  | { readonly kind: "exited"; readonly ready: boolean };

const mintToken = (): Token =>
  Redacted.make(
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  );

export const makeSupervisor = (options: {
  /** Spawn one backend with a fresh one-use bootstrap token. */
  readonly start: (
    token: Token,
  ) => Effect.Effect<
    BackendRun,
    DesktopFailed,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >;
  /** True once the app has begun quitting; exits after that need no recovery. */
  readonly quitting: Effect.Effect<boolean>;
  /** A run is starting; show the startup page. */
  readonly onStarting: Effect.Effect<void>;
  /** The run is ready. Scoped to that run, so forwarding stops when it exits. */
  readonly onReady: (run: BackendRun, origin: string) => Effect.Effect<void, never, Scope.Scope>;
  /** Supervision stopped; show the recovery page. */
  readonly onRecovery: (recovery: DesktopRecovery) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const spawner = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
    const lock = yield* Semaphore.make(1);
    const supervision = yield* Ref.make(Option.none<Fiber.Fiber<void>>());
    const current = yield* Ref.make(Option.none<BackendRun>());
    const runs = yield* Ref.make(0);

    const report = (runId: number, exit: BackendExit, kind: string) =>
      (kind === "external-shutdown" ? Effect.logWarning : Effect.logError)(
        "Desktop backend exited",
      ).pipe(
        Effect.annotateLogs({
          run: runId,
          kind,
          exitCode: exit.code,
          signal: exit.signal,
          ready: exit.ready,
          configuration: Option.getOrUndefined(exit.configuration),
          stderr: exit.stderr,
        }),
      );

    const runOnce = Effect.gen(function* () {
      const runId = yield* Ref.updateAndGet(runs, (value) => value + 1);
      const started = yield* options.start(mintToken()).pipe(Effect.option);
      if (Option.isNone(started)) return { kind: "recover", recovery: { stage: "start" } } as const;
      const run = started.value;
      yield* Effect.acquireRelease(Ref.set(current, Option.some(run)), () =>
        Ref.set(current, Option.none()),
      );
      const first = yield* Effect.raceFirst(
        run.ready.pipe(
          Effect.timeoutOption(readyTimeout),
          Effect.orElseSucceed(() => Option.none<string>()),
          Effect.map((origin) => ({ kind: "ready", origin }) as const),
        ),
        run.exited.pipe(Effect.map((exit) => ({ kind: "exited", exit }) as const)),
      );
      let exit: BackendExit;
      if (first.kind === "exited") exit = first.exit;
      else if (Option.isNone(first.origin)) {
        // A bad readiness line or no readiness in time: stop this run and keep its output.
        yield* report(runId, yield* run.stop, "ready");
        return { kind: "recover", recovery: { stage: "ready" } } as const;
      } else {
        yield* Effect.logInfo("Desktop backend ready").pipe(
          Effect.annotateLogs({ run: runId, origin: first.origin.value }),
        );
        yield* options.onReady(run, first.origin.value);
        exit = yield* run.exited;
      }
      const kind = classifyBackendExit(exit, yield* options.quitting);
      if (kind.kind === "managed-stop") {
        yield* Effect.logInfo("Desktop backend stopped").pipe(Effect.annotateLogs({ run: runId }));
        return { kind: "stopped" } as const;
      }
      yield* report(runId, exit, kind.kind);
      if (Option.isSome(exit.configuration))
        return {
          kind: "recover",
          recovery: { stage: "configuration", reason: exit.configuration.value },
        } as const;
      return { kind: "exited", ready: exit.ready } as const;
    });

    const supervise = Effect.gen(function* () {
      let exits: ReadonlyArray<number> = [];
      let attempt = 0;
      while (true) {
        yield* options.onStarting;
        const outcome: Outcome = yield* Effect.scoped(runOnce);
        if (outcome.kind === "stopped") return;
        if (outcome.kind === "recover") return yield* options.onRecovery(outcome.recovery);
        if (outcome.ready) attempt = 0;
        const now = yield* Clock.currentTimeMillis;
        exits = [...exits.filter((at) => now - at < Duration.toMillis(crashLoopWindow)), now];
        if (exits.length >= crashLoopExits)
          return yield* options.onRecovery({ stage: "crash-loop" });
        const delay = restartDelay(attempt);
        attempt += 1;
        yield* Effect.logInfo("Restarting the desktop backend").pipe(
          Effect.annotateLogs({ delayMillis: Duration.toMillis(delay) }),
        );
        yield* Effect.sleep(delay);
      }
    }).pipe(Effect.provideContext(spawner));

    const stopUnlocked = Effect.gen(function* () {
      const fiber = yield* Ref.getAndSet(supervision, Option.none());
      if (Option.isNone(fiber)) return;
      const run = yield* Ref.get(current);
      if (Option.isSome(run)) yield* run.value.stop;
      yield* Fiber.interrupt(fiber.value);
    });

    const startUnlocked = Effect.gen(function* () {
      yield* stopUnlocked;
      const fiber = yield* Effect.forkIn(supervise, scope);
      yield* Ref.set(supervision, Option.some(fiber));
    });

    return {
      /** Start supervision, first stopping any current backend. Calls are serialized. */
      start: lock.withPermit(startUnlocked),
      /**
       * Stop the backend, run `effect` and start again. No other start can run in between, so
       * nothing can use the data directory while `effect` works on it.
       */
      whileStopped: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        lock.withPermit(stopUnlocked.pipe(Effect.andThen(effect), Effect.ensuring(startUnlocked))),
    };
  });

export type Supervisor = Effect.Success<ReturnType<typeof makeSupervisor>>;
