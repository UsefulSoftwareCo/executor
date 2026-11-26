import { RuntimeProtocolFailed } from "../contracts/runtime.ts";
import type { WorkerLoader } from "@cloudflare/workers-types";
import { Clock, Config, type Context, Effect, Option, Schema } from "effect";
import { replaceWorker, unloadWorker } from "@executor-js/app-data/cloudflare";

export const defaultAppWorkerLimit = 64;
export const appWorkerLimit = Config.schema(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  "EXECUTOR_APP_WORKERS",
).pipe(Config.option);
export const defaultAppWorkerIdleSeconds = 300;
export const appWorkerIdleSeconds = Config.schema(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  "EXECUTOR_APP_WORKER_IDLE_SECONDS",
).pipe(Config.option);
const unloadLimit = "10 seconds";
const waitLimit = 15_000;

interface Resident {
  active: number;
  lastUsed: number;
  unloading: Promise<void> | undefined;
  readonly unload: Unload;
}

export interface Unload {
  readonly run: Effect.Effect<boolean>;
  readonly abandon: () => void;
}

export const namedWorker = (loader: Pick<WorkerLoader, "get">, name: string): Unload => ({
  run: Effect.promise(() => unloadWorker(loader, name)),
  abandon: () => replaceWorker(name),
});

export interface AppWorkerResidency {
  readonly hold: (
    name: string,
    unload: Unload,
    waitUntil: (task: Promise<unknown>) => void,
  ) => Effect.Effect<Effect.Effect<void>, RuntimeProtocolFailed>;
}

export interface AppWorkerResidencyOptions {
  readonly limit: number;
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
        const unloading = Effect.runPromiseWith(services)(unload(name, resident));
        resident.unloading = unloading;
        unloads.push(unloading);
      }
      return unloads.length === 0 ? Effect.void : Effect.promise(() => Promise.all(unloads));
    });

  const expire = (now: number) =>
    Effect.contextWith((services: Context.Context<never>) => {
      const unloads: Array<Promise<void>> = [];
      for (const [name, resident] of residents) {
        if (resident.unloading !== undefined || resident.active > 0) continue;
        if (now - resident.lastUsed < idleMillis) continue;
        const unloading = Effect.runPromiseWith(services)(unload(name, resident));
        resident.unloading = unloading;
        unloads.push(unloading);
      }
      return unloads.length === 0 ? Effect.void : Effect.promise(() => Promise.all(unloads));
    });

  const nextExpiry = () => {
    let next: number | undefined;
    for (const resident of residents.values()) {
      if (resident.unloading !== undefined || resident.active > 0) continue;
      const expiry = resident.lastUsed + idleMillis;
      if (next === undefined || expiry < next) next = expiry;
    }
    return next;
  };

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
      sweepAt = first;
      const services = yield* Effect.context<never>();
      waitUntil(
        Effect.runPromiseWith(services)(
          sweep(first).pipe(
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
        const current = residents.get(name);
        if (current?.unloading !== undefined) {
          const until = now + waitLimit;
          while (residents.get(name) === current) {
            if ((yield* Clock.currentTimeMillis) > until)
              return yield* new RuntimeProtocolFailed({ reason: "unloading" });
            yield* Effect.sleep("10 millis");
          }
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
