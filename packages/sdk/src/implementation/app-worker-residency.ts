/**
 * The app Workers one workerd process keeps loaded. The pinned workerd never unloads a named
 * Worker Loader entry by itself, so without a bound every app and account selection a process ever
 * called stays resident, and memory grows with them. A host that owns its workerd process gives
 * its runner this residency: it counts the calls in flight in each named Worker and, whenever more
 * Workers are loaded than the configured limit, unloads the least recently used idle ones. The
 * facet Workers that run database calls count against the same limit as app Workers. A Worker
 * with a call in flight, including an unfinished release, a paused elicitation or a running
 * workflow, is never unloaded, so no work is lost (a release that outlives its limit keeps its
 * hold until it settles); while every loaded Worker is busy the limit is
 * exceeded until calls finish. Below the limit, a Worker left idle for the configured idle time is
 * unloaded too, so an app called once does not keep its isolate for the life of the process. The
 * next call of an unloaded Worker cold-starts it from its build.
 *
 * The state lives in the runner's own isolate, which workerd keeps for the life of the process.
 * Cloud has no residency: Cloudflare unloads its Workers itself.
 */
import type { WorkerLoader } from "@cloudflare/workers-types";
import { Clock, Config, type Context, Effect, Option, Schema } from "effect";
import { replaceWorker, unloadWorker } from "@executor-js/app-data/cloudflare";

/**
 * Loaded app and facet Workers a self-host or local process keeps when no limit is configured: an
 * app Worker and a facet Worker each for 32 apps with databases called in turn.
 */
export const defaultAppWorkerLimit = 64;
/**
 * The operator's limit on loaded app Workers, `EXECUTOR_APP_WORKERS`. Each loaded Worker holds its
 * own isolate, so this bounds the memory app code uses however many apps and accounts are called.
 */
export const appWorkerLimit = Config.schema(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  "EXECUTOR_APP_WORKERS",
).pipe(Config.option);
/** Seconds an idle Worker stays loaded when no idle time is configured. */
export const defaultAppWorkerIdleSeconds = 300;
/**
 * The operator's idle time, `EXECUTOR_APP_WORKER_IDLE_SECONDS`: a Worker with no call in flight
 * that has not been called for this long is unloaded even below the limit. Zero keeps idle Workers
 * loaded until the limit unloads them.
 */
export const appWorkerIdleSeconds = Config.schema(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  "EXECUTOR_APP_WORKER_IDLE_SECONDS",
).pipe(Config.option);
/** An unload that has not settled by then is abandoned; its name then loads fresh code. */
const unloadLimit = "10 seconds";

interface Resident {
  active: number;
  lastUsed: number;
  unloading: Promise<void> | undefined;
  readonly unload: Unload;
}

/** How to unload one resident Worker. */
export interface Unload {
  /** True once the runtime dropped the Worker, false when it could not. */
  readonly run: Effect.Effect<boolean>;
  /** Called when `run` did not settle in time; later calls must not reach the old Worker. */
  readonly abandon: () => void;
}

/** Unload a Worker Loader entry by name; one that does not settle is replaced under a fresh name. */
export const namedWorker = (loader: Pick<WorkerLoader, "get">, name: string): Unload => ({
  run: Effect.promise(() => unloadWorker(loader, name)),
  abandon: () => replaceWorker(name),
});

export interface AppWorkerResidency {
  /**
   * Hold a named Worker for one call. Waits while the name is being unloaded, and unloads idle
   * Workers above the limit before the call loads its own. Returns the call's release.
   * `waitUntil` keeps the idle sweep the call may start alive after the call's request ends.
   */
  readonly hold: (
    name: string,
    unload: Unload,
    waitUntil: (task: Promise<unknown>) => void,
  ) => Effect.Effect<Effect.Effect<void>>;
}

export interface AppWorkerResidencyOptions {
  /** Most Workers kept loaded while some are idle. */
  readonly limit: number;
  /** Seconds an idle Worker stays loaded below the limit; zero never unloads it for idling. */
  readonly idleSeconds: number;
}

export const makeAppWorkerResidency = ({
  limit,
  idleSeconds,
}: AppWorkerResidencyOptions): AppWorkerResidency => {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError("The app Worker limit must be a positive integer");
  if (!Number.isSafeInteger(idleSeconds) || idleSeconds < 0)
    throw new RangeError("The app Worker idle time must be a non-negative integer");
  const idleMillis = idleSeconds * 1000;
  const residents = new Map<string, Resident>();
  /** When the armed idle sweep runs, or undefined when none is armed. */
  let sweepAt: number | undefined;

  const unload = (name: string, resident: Resident) =>
    resident.unload.run.pipe(
      Effect.timeoutOption(unloadLimit),
      Effect.tap((settled) =>
        Effect.sync(() => {
          if (Option.isNone(settled)) resident.unload.abandon();
        }),
      ),
      Effect.tap((settled) =>
        Effect.annotateCurrentSpan({
          "executor.worker.identity": name,
          "executor.worker.unloaded": Option.getOrElse(settled, () => false),
          "executor.worker.unload_timed_out": Option.isNone(settled),
        }),
      ),
      Effect.withSpan("runtime.app.worker.unload"),
      Effect.asVoid,
      Effect.catchCause(() => Effect.void),
      Effect.ensuring(
        Effect.sync(() => {
          if (residents.get(name) === resident) residents.delete(name);
        }),
      ),
    );

  /** Unload least recently used idle Workers until at most `limit` stay loaded. */
  const trim = () =>
    Effect.contextWith((services: Context.Context<never>) => {
      let loaded = 0;
      const idle: Array<[string, Resident]> = [];
      for (const entry of residents) {
        if (entry[1].unloading !== undefined) continue;
        loaded++;
        if (entry[1].active === 0) idle.push(entry);
      }
      idle.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      const unloads: Array<Promise<void>> = [];
      for (const [name, resident] of idle) {
        if (loaded <= limit) break;
        loaded--;
        // Claimed synchronously, so a call of this name waits instead of reaching the old Worker.
        const unloading = Effect.runPromiseWith(services)(unload(name, resident));
        resident.unloading = unloading;
        unloads.push(unloading);
      }
      return unloads.length === 0 ? Effect.void : Effect.promise(() => Promise.all(unloads));
    });

  /** Claim and unload every idle Worker unused for the idle time. */
  const expire = (now: number) =>
    Effect.contextWith((services: Context.Context<never>) => {
      const unloads: Array<Promise<void>> = [];
      for (const [name, resident] of residents) {
        if (resident.unloading !== undefined || resident.active > 0) continue;
        if (now - resident.lastUsed < idleMillis) continue;
        // Claimed synchronously, as in `trim`, so a call of this name waits for the unload.
        const unloading = Effect.runPromiseWith(services)(unload(name, resident));
        resident.unloading = unloading;
        unloads.push(unloading);
      }
      return unloads.length === 0 ? Effect.void : Effect.promise(() => Promise.all(unloads));
    });

  /** When the next idle Worker expires, or undefined when no loaded Worker is idle. */
  const nextExpiry = () => {
    let next: number | undefined;
    for (const resident of residents.values()) {
      if (resident.unloading !== undefined || resident.active > 0) continue;
      const expiry = resident.lastUsed + idleMillis;
      if (next === undefined || expiry < next) next = expiry;
    }
    return next;
  };

  /**
   * Sleep until the next idle Worker expires, unload the expired ones and repeat while any loaded
   * Worker is idle. Timers in workerd belong to a request, so the sweep runs under the `waitUntil`
   * of the call that armed it and outlives that call's response. A Worker's expiry only moves
   * later, so one sweep, armed for the earliest one, covers every Worker that becomes idle after
   * it. A sweep whose time has passed is presumed lost with its request and is armed again.
   */
  const arm = (now: number, waitUntil: (task: Promise<unknown>) => void) =>
    Effect.gen(function* () {
      if (idleMillis === 0 || (sweepAt !== undefined && sweepAt >= now)) return;
      const first = nextExpiry();
      if (first === undefined) return;
      const sweep = (at: number): Effect.Effect<void> =>
        Effect.gen(function* () {
          sweepAt = at;
          yield* Effect.sleep(Math.max(0, at - (yield* Clock.currentTimeMillis)));
          if (sweepAt !== at) return;
          yield* expire(yield* Clock.currentTimeMillis);
          if (sweepAt !== at) return;
          sweepAt = undefined;
          const next = nextExpiry();
          if (next !== undefined) yield* sweep(next);
        });
      // Set before the sweep starts, so a release in between does not arm a second one.
      sweepAt = first;
      const services = yield* Effect.context<never>();
      waitUntil(
        Effect.runPromiseWith(services)(
          sweep(first).pipe(
            // Its own trace: it outlives the call that armed it by the idle time.
            Effect.withSpan("runtime.app.worker.idle_sweep", { root: true }),
            Effect.catchCause(() => Effect.void),
          ),
        ),
      );
    });

  const hold = (name: string, unload: Unload, waitUntil: (task: Promise<unknown>) => void) =>
    Effect.gen(function* () {
      let resident: Resident | undefined;
      while (resident === undefined) {
        const now = yield* Clock.currentTimeMillis;
        // Checked and claimed without yielding, so an unload cannot start in between.
        const current = residents.get(name);
        if (current?.unloading !== undefined) {
          const pending = current.unloading;
          yield* Effect.promise(() => pending);
          continue;
        }
        resident = current ?? {
          active: 0,
          lastUsed: now,
          unloading: undefined,
          unload,
        };
        resident.active++;
        resident.lastUsed = now;
        residents.set(name, resident);
      }
      const held = resident;
      yield* trim();
      let released = false;
      return Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Effect.suspend(() => {
            if (released) return Effect.void;
            released = true;
            held.active--;
            held.lastUsed = now;
            return trim().pipe(Effect.andThen(arm(now, waitUntil)));
          }),
        ),
      );
    });

  return { hold };
};
