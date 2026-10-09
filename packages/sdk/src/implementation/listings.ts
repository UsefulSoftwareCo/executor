/** Evaluated tool listings, reused across requests through the declaration store. */
import { Cause, Clock, Effect, Exit, Fiber, Option } from "effect";
import {
  defaultToolListingPolicy,
  durableHeadStartMillis,
  type BackgroundWork,
  type DeclarationCache,
  type PendingLoad,
  type ToolListingPolicy,
} from "../contracts/declarations.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import {
  type Tool,
  ToolListingTimedOut,
  type AppEvaluationFailed,
  type AppProviderFailed,
  type ToolListOptions,
  type ToolRouter,
} from "../contracts/tools.ts";
import type { DeploymentId, ProfileId } from "../contracts/shared.ts";
import type { Declarations } from "./declarations.ts";
import { makeHandoff } from "./handoff.ts";
import { decodeListing, shareListing } from "./listing-json.ts";
import type { makeOAuth } from "./oauth.ts";
import { resolve, type InvocationSnapshot } from "./tools.ts";

/** Every tool of one app for one invocation state, sorted by name. */
export interface ToolListing {
  readonly catalog: {
    readonly deployment: DeploymentId;
    readonly profile?: ProfileId;
    readonly profileRevision?: number;
  };
  readonly items: ReadonlyArray<Tool>;
  /** Every router in the catalog, on every page. */
  readonly routers: ReadonlyArray<ToolRouter>;
}

/** Failures of the evaluation itself. Credential and storage failures are never remembered. */
export type ListingFailure = AppEvaluationFailed | AppProviderFailed | ToolListingTimedOut;
type ResolveError = Effect.Error<ReturnType<typeof resolve>>;

/** A kept listing. */
class Listed {
  readonly listing: ToolListing;
  constructor(listing: ToolListing) {
    this.listing = listing;
  }
}
/**
 * What a finished evaluation left for its readers. Its listing is kept as `Listed`, like a
 * `Failed` one; of the others, nothing is. The listing's tools share their definitions, and its
 * text is encoded only to keep it beyond this process.
 */
class Evaluated {
  readonly listed: Listed;
  readonly bytes: number;
  readonly sizes: ReturnType<typeof shareListing>["sizes"];
  readonly json: ReturnType<typeof shareListing>["json"];
  constructor(shared: ReturnType<typeof shareListing>) {
    this.listed = new Listed(shared.listing);
    this.bytes = shared.bytes;
    this.sizes = shared.sizes;
    this.json = shared.json;
  }
}
class Failed {
  readonly error: ListingFailure;
  /** When it failed; a remembered failure is reported for `freshMillis` from then. */
  readonly at: number;
  constructor(error: ListingFailure, at: number) {
    this.error = error;
    this.at = at;
  }
}
class Unkept {
  readonly error: ResolveError;
  constructor(error: ResolveError) {
    this.error = error;
  }
}
/** Interrupted before it finished, by its owning reader or by the host. */
class Stopped {
  readonly elapsedMs: number;
  constructor(elapsedMs: number) {
    this.elapsedMs = elapsedMs;
  }
}
type Outcome = Evaluated | Failed | Unkept | Stopped;

/**
 * Keep each evaluated listing in the shared declaration store under the declaration key, so a
 * new deployment, profile revision, account selection or stored credential is another listing,
 * and serve anything this read did not evaluate itself only after the checks a live evaluation
 * runs before it releases credentials: a kept listing, a remembered failure, and the result of
 * an evaluation another request started.
 *
 * A listing younger than `freshMillis` is served as is; an older one is served while one
 * background evaluation replaces it; past `maxStaleMillis` the read evaluates first. Readers of a
 * key share one evaluation. A first evaluation runs in the background when the host allows it,
 * so a reader that stops waiting, such as MCP discovery giving up on a stalled app, leaves it
 * running until `loadMillis` or until the host ends its background work, whichever is first, and
 * its listing is kept when it finishes. Either stop is remembered as a timeout. A reader that passes
 * `reportRunningAfterMillis` is told at once about an evaluation that has run longer than that,
 * or that such a reader already gave up on; other readers wait for it. A slow failure is reported
 * at once to such a reader for `freshMillis` after it failed, while one background evaluation at a
 * time retries; other readers evaluate again, so they never see a failure a live read would not. Kept listings are shared by reference and
 * never mutated, so consumers may derive projections that live exactly as long as the listing.
 */
export const makeListings = (options: {
  readonly cache: DeclarationCache;
  readonly background: BackgroundWork | undefined;
  readonly declarations: Declarations;
  readonly resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"];
  readonly lifecycle: ResourceLifecycle | undefined;
  readonly policy?: ToolListingPolicy;
}) => {
  const policy = options.policy ?? defaultToolListingPolicy;
  const { cache, background } = options;
  return {
    read: (
      state: InvocationSnapshot,
      /** May renew a refused account, which fails like resolving it; such failures are not kept. */
      evaluate: (
        context: Effect.Success<ReturnType<typeof resolve>>,
      ) => Effect.Effect<ToolListing, AppEvaluationFailed | AppProviderFailed | ResolveError>,
      read: ToolListOptions = {},
    ) =>
      Effect.gen(function* () {
        const identity = { app: state.app.id, deployment: state.deployment.id };
        const evaluated = resolve(state, options.resolveAccount, options.lifecycle).pipe(
          Effect.flatMap(evaluate),
        );
        if (policy.maxStaleMillis <= 0) return yield* evaluated;
        const id = yield* options.declarations.key("tools.list", state);
        const now = yield* Clock.currentTimeMillis;
        const authorize = options.declarations.authorize(state);
        const timedOut = (elapsedMs: number, running: boolean) =>
          new ToolListingTimedOut({ ...identity, elapsedMs, running });
        const pendingLoad = (started: number): PendingLoad => ({
          started,
          waiters: 0,
          overdue: false,
          unwatched: makeHandoff(),
          done: makeHandoff(),
        });

        /** Keep a listing, or a slow failure unless a listing that may still be served exists. */
        const keep = (outcome: Outcome, load: PendingLoad) =>
          Effect.gen(function* () {
            if (outcome instanceof Evaluated) {
              // What the evaluation's CPU, which a Workers I/O clock cannot time, grows with.
              yield* Effect.annotateCurrentSpan(outcome.sizes);
              yield* cache.set(id, {
                kind: "value",
                app: state.app.id,
                at: load.started,
                value: outcome.listed,
                bytes: outcome.bytes,
              });
              return;
            }
            if (!(outcome instanceof Failed)) return;
            if (
              outcome.error._tag !== "ToolListingTimedOut" &&
              outcome.at - load.started < policy.slowFailureMillis
            )
              return;
            const current = yield* cache.get(id);
            if (
              current?.kind === "value" &&
              current.value instanceof Listed &&
              outcome.at - current.at < policy.maxStaleMillis
            )
              return;
            // Stamped with its start, so an app cache change during the evaluation discards it.
            yield* cache.set(id, {
              kind: "value",
              app: state.app.id,
              at: load.started,
              value: outcome,
              bytes: 0,
            });
          });
        /**
         * Keep a listing beyond this process. It runs after the evaluation's readers have their
         * outcome, and encodes with the write, so they never wait for it.
         */
        const store = (outcome: Outcome, load: PendingLoad) =>
          outcome instanceof Evaluated
            ? options.declarations.persist(
                state.app.id,
                id,
                outcome.json.pipe(
                  Effect.map((json) => ({
                    at: load.started,
                    json,
                    until: load.started + policy.maxStaleMillis,
                  })),
                ),
              )
            : Effect.void;
        /**
         * Stops the evaluation once it has run for `loadMillis` with no reader waiting: at that
         * point if nobody waits, otherwise when the last waiting reader leaves.
         */
        const unwatched = (load: PendingLoad) =>
          Effect.gen(function* () {
            yield* Effect.sleep(policy.loadMillis);
            if (load.waiters > 0) yield* load.unwatched.await;
            const at = yield* Clock.currentTimeMillis;
            return new Failed(timedOut(at - load.started, false), at) as Outcome;
          });
        /**
         * Evaluate once for every reader of this key, keeping the listing or its failure. The
         * host interrupts an evaluation it runs as background work only when its background
         * lifetime ends, after the evaluation had all the time the host gives such work, so that
         * stop is remembered as a timeout, like one after `loadMillis`. A reader that owns the
         * evaluation stops it by leaving, which says nothing about how long the listing takes.
         */
        const run = (load: PendingLoad, owner: "host" | "reader") =>
          evaluated.pipe(
            // Before readers have it, so they share its definitions too.
            Effect.map((listing): Outcome => new Evaluated(shareListing(listing))),
            Effect.catch((error) =>
              Clock.currentTimeMillis.pipe(
                Effect.map((at): Outcome =>
                  error._tag === "AppEvaluationFailed" || error._tag === "AppProviderFailed"
                    ? new Failed(error, at)
                    : new Unkept(error),
                ),
              ),
            ),
            Effect.raceFirst(unwatched(load)),
            Effect.tap((outcome) => keep(outcome, load)),
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                if (Exit.isSuccess(exit)) {
                  cache.end(id, load);
                  return yield* load.done.settle(exit.value);
                }
                // Remembered before it leaves `pending`, like an outcome kept above, so a reader
                // always finds one of them.
                const at = yield* Clock.currentTimeMillis;
                if (
                  (owner === "host" && Cause.hasInterruptsOnly(exit.cause)) ||
                  at - load.started >= policy.loadMillis
                )
                  yield* keep(new Failed(timedOut(at - load.started, false), at), load);
                cache.end(id, load);
                yield* load.done.settle(new Stopped(at - load.started));
              }),
            ),
            // In the evaluation's own fiber: background work that offered the write as new
            // background work would find the host refusing it once the request is closing.
            Effect.flatMap((outcome) => store(outcome, load)),
            Effect.withSpan("sdk.tools.listing.evaluate"),
            // Background work may start uninterruptible; its time bound must still stop it.
            Effect.interruptible,
          );
        /** Start an evaluation nobody waits for, unless one is running or the host refuses. */
        const refresh = Effect.uninterruptible(
          Effect.gen(function* () {
            if (background === undefined || cache.pending(id) !== undefined) return;
            const load = pendingLoad(yield* Clock.currentTimeMillis);
            cache.begin(id, load);
            if (yield* background(run(load, "host"))) return;
            cache.end(id, load);
            yield* load.done.settle(new Stopped(0));
          }),
        );
        const outcome = (value: unknown) =>
          Effect.gen(function* () {
            if (value instanceof Evaluated) return value.listed.listing;
            if (value instanceof Failed || value instanceof Unkept)
              return yield* Effect.fail(value.error);
            const elapsed = value instanceof Stopped ? value.elapsedMs : 0;
            return yield* Effect.fail(timedOut(elapsed, false));
          });
        /**
         * Wait for an evaluation this read did not run itself, then check access as for a kept
         * listing: it may have been evaluated for another request, and access may have changed
         * while it ran. A reader that stops waiting leaves it running; one with a wait bound that
         * gives up after the evaluation has run for half that bound marks it overdue. A reader
         * interrupted sooner, such as a finished program, says nothing about the evaluation.
         */
        const join = (load: PendingLoad) =>
          Effect.gen(function* () {
            load.waiters += 1;
            const bound = read.reportRunningAfterMillis;
            const done = yield* load.done.await.pipe(
              Effect.onInterrupt(() =>
                Clock.currentTimeMillis.pipe(
                  Effect.map((at) => {
                    if (bound !== undefined && at - load.started >= bound / 2) load.overdue = true;
                  }),
                ),
              ),
              Effect.ensuring(
                Effect.suspend(() => {
                  load.waiters -= 1;
                  return load.waiters === 0
                    ? Clock.currentTimeMillis.pipe(
                        Effect.flatMap((at) =>
                          at - load.started >= policy.loadMillis
                            ? load.unwatched.settle(undefined)
                            : Effect.void,
                        ),
                      )
                    : Effect.void;
                }),
              ),
              Effect.exit,
            );
            yield* authorize;
            if (Exit.isFailure(done)) return yield* Effect.failCause(done.cause);
            return yield* outcome(done.value);
          });

        // Without background work a stale listing is evaluated again first, like a missing one.
        const servable = (at: number) =>
          now - at < policy.freshMillis ||
          (now - at < policy.maxStaleMillis && background !== undefined);
        /** Serve a kept listing, refreshing it in the background once it is past `freshMillis`. */
        const serve = (at: number, listed: Listed, source: "memory" | "durable") =>
          Effect.gen(function* () {
            yield* authorize;
            const stale = now - at >= policy.freshMillis;
            yield* Effect.annotateCurrentSpan({
              "executor.declarations.cache": stale ? "stale" : "hit",
              "executor.declarations.source": source,
              "executor.declarations.age_ms": now - at,
            });
            if (stale) yield* refresh;
            return listed.listing;
          });

        const keptListing = cache
          .get(id)
          .pipe(
            Effect.map((entry) =>
              entry?.kind === "value" &&
              (entry.value instanceof Listed || entry.value instanceof Failed)
                ? { at: entry.at, value: entry.value }
                : undefined,
            ),
          );
        const early = yield* keptListing;
        if (early?.value instanceof Listed && servable(early.at))
          return yield* serve(early.at, early.value, "memory");
        // Another isolate's listing, unless an invalidation seen here replaced it. It is kept
        // here too when it fits. A remembered failure here does not hide it.
        const recalling = yield* Effect.forkChild(
          options.declarations.recall(state.app.id, id).pipe(
            Effect.flatMap((recalled) =>
              Effect.gen(function* () {
                if (
                  recalled === undefined ||
                  !servable(recalled.at) ||
                  cache.outdated(state.app.id, recalled.at)
                )
                  return undefined;
                const decoded = yield* decodeListing(recalled.json).pipe(Effect.option);
                if (Option.isNone(decoded)) return undefined;
                const listed = new Listed(decoded.value);
                yield* cache.set(id, {
                  kind: "value",
                  app: state.app.id,
                  at: recalled.at,
                  value: listed,
                  bytes: recalled.json.length * 2,
                });
                return { at: recalled.at, listed };
              }),
            ),
          ),
        );
        const recalled = yield* Fiber.join(recalling).pipe(
          Effect.timeoutOption(durableHeadStartMillis),
        );
        if (Option.isSome(recalled) && recalled.value !== undefined)
          return yield* serve(recalled.value.at, recalled.value.listed, "durable");
        /**
         * A slow durable read, often a Durable Object waking up, would delay every miss: wait for
         * an evaluation beside it and answer with whichever settles first. A listing the read
         * finds still wins.
         */
        const orRecalled = <E, R>(evaluation: Effect.Effect<ToolListing, E, R>) =>
          Option.isSome(recalled)
            ? evaluation
            : Effect.raceFirst(
                evaluation,
                Fiber.join(recalling).pipe(
                  Effect.flatMap((found) =>
                    found === undefined ? Effect.never : serve(found.at, found.listed, "durable"),
                  ),
                ),
              );
        // The durable read yielded, and an evaluation may have ended meanwhile. One that ends
        // keeps its listing or failure before it leaves `pending`, so reading what runs before
        // what is kept never misses both.
        const before = cache.pending(id);
        const kept = yield* keptListing;
        if (kept?.value instanceof Listed && servable(kept.at))
          return yield* serve(kept.at, kept.value, "memory");
        // A remembered failure spares a reader with a wait bound, such as MCP discovery, from
        // waiting on the evaluation again. A reader prepared to wait, such as the dashboard,
        // joins or starts a live evaluation instead, so a recovered upstream shows at once.
        if (
          kept?.value instanceof Failed &&
          now - kept.value.at < policy.freshMillis &&
          read.reportRunningAfterMillis !== undefined
        ) {
          yield* authorize;
          yield* Effect.annotateCurrentSpan("executor.declarations.cache", "failed");
          yield* refresh;
          return yield* Effect.fail(kept.value.error);
        }
        // Read again so that checking and registering below happen without yielding.
        const running = cache.pending(id);
        if (running === undefined && before !== undefined) {
          // It ended after the read above: the outcome it left is there already.
          yield* Effect.annotateCurrentSpan("executor.declarations.cache", "joined");
          return yield* join(before);
        }
        if (running !== undefined) {
          const elapsed = now - running.started;
          const bound = read.reportRunningAfterMillis;
          if (bound !== undefined && (running.overdue || elapsed >= bound)) {
            yield* authorize;
            yield* Effect.annotateCurrentSpan("executor.declarations.cache", "running");
            return yield* Effect.fail(timedOut(elapsed, true));
          }
          yield* Effect.annotateCurrentSpan("executor.declarations.cache", "joined");
          return yield* orRecalled(join(running));
        }
        // Checking for a running evaluation and registering this one happen without yielding.
        const load = pendingLoad(now);
        cache.begin(id, load);
        yield* Effect.annotateCurrentSpan("executor.declarations.cache", "miss");
        const detached =
          background === undefined
            ? false
            : yield* Effect.uninterruptible(background(run(load, "host")));
        if (detached) return yield* orRecalled(join(load));
        // Without background work the evaluation belongs to this reader and stops with it.
        load.waiters = 1;
        yield* run(load, "reader");
        return yield* outcome(yield* load.done.await);
      }).pipe(
        Effect.withSpan("sdk.tools.listing", {
          attributes: { "executor.app.id": state.app.id },
        }),
      ),
  };
};
export type Listings = ReturnType<typeof makeListings>;
