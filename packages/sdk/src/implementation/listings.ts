import { Cause, Clock, Effect, Exit, Fiber, Option, Result, Schema, Semaphore } from "effect";
import {
  defaultToolListingPolicy,
  durableHeadStartMillis,
  type BackgroundWork,
  type DeclarationCache,
  type PendingLoad,
  type ToolListingPolicy,
} from "../contracts/declarations.ts";
import {
  refusedHostApi,
  type Tool,
  ToolListingTimedOut,
  ToolSearchListing,
  ToolSearchUnavailable,
  type AppEvaluationFailed,
  type AppProviderFailed,
  type ToolListOptions,
  type ToolRouter,
} from "../contracts/tools.ts";
import type { AppAccounts } from "../contracts/apps.ts";
import { OAuthReconnectRequired } from "../contracts/oauth.ts";
import type { OwnerId, VersionId } from "../contracts/shared.ts";
import type { Declarations } from "./declarations.ts";
import { makeHandoff } from "./handoff.ts";
import { decodeListing, shareListing } from "./listing-json.ts";
import type { makeOAuth } from "./oauth.ts";
import { reconnectReported, resolve, type InvocationSnapshot } from "./tools.ts";
import type { ToolSearch } from "./tool-search.ts";

export interface ToolListing {
  readonly catalog: {
    readonly version: VersionId;
    readonly accounts: AppAccounts;
  };
  readonly items: ReadonlyArray<Tool>;
  readonly routers: ReadonlyArray<ToolRouter>;
  readonly itemChars?: ReadonlyArray<number>;
}

export type ListingFailure = AppEvaluationFailed | AppProviderFailed | ToolListingTimedOut;
type ResolveError = Effect.Error<ReturnType<typeof resolve>>;

interface Served {
  readonly listing: ToolListing;
  readonly at: number;
}

type Evaluate = (
  context: Effect.Success<ReturnType<typeof resolve>>,
) => Effect.Effect<ToolListing, AppEvaluationFailed | AppProviderFailed | ResolveError>;

export interface SearchableAhead {
  readonly running: PendingLoad | undefined;
  readonly kept: Effect.Success<ReturnType<ToolSearch["listing"]>> | undefined;
  readonly access: Result.Result<void, Effect.Error<ReturnType<Declarations["authorize"]>>>;
}

interface ListingRead extends ToolListOptions {
  readonly resolved?: Effect.Success<ReturnType<typeof resolve>>;
  readonly retain?: boolean;
  readonly hosted?: boolean;
  readonly followChanges?: boolean;
  readonly newerThan?: number;
}

class Listed {
  readonly listing: ToolListing;
  constructor(listing: ToolListing) {
    this.listing = listing;
  }
}
class Evaluated {
  readonly listed: Listed;
  readonly bytes: number;
  readonly sizes: ReturnType<typeof shareListing>["sizes"];
  readonly json: ReturnType<typeof shareListing>["json"];
  constructor(shared: ReturnType<typeof shareListing>) {
    this.listed = new Listed({ ...shared.listing, itemChars: shared.itemChars });
    this.bytes = shared.bytes;
    this.sizes = shared.sizes;
    this.json = shared.json;
  }
}
class Failed {
  readonly error: ListingFailure;
  readonly at: number;
  constructor(error: ListingFailure, at: number) {
    this.error = error;
    this.at = at;
  }
}
class Renewal {
  readonly failure: AppEvaluationFailed | AppProviderFailed | undefined;
  constructor(failure?: AppEvaluationFailed | AppProviderFailed) {
    this.failure = failure;
  }
}
class Unkept {
  readonly error: ResolveError;
  constructor(error: ResolveError) {
    this.error = error;
  }
}
class Stopped {
  readonly elapsedMs: number;
  constructor(elapsedMs: number) {
    this.elapsedMs = elapsedMs;
  }
}
type Outcome = Evaluated | Failed | Unkept | Stopped;

const partial = (routers: ReadonlyArray<ToolRouter>) =>
  routers.some((router) => router.path === "" && router.error !== undefined);

export const makeListings = (options: {
  readonly cache: DeclarationCache;
  readonly background: BackgroundWork | undefined;
  readonly declarations: Declarations;
  readonly resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"];
  readonly policy?: ToolListingPolicy;
  readonly search: ToolSearch;
}) => {
  const policy = options.policy ?? defaultToolListingPolicy;
  const { cache, background, search } = options;
  const searchFillLimit = 2;
  const searchFillGate = Semaphore.makeUnsafe(searchFillLimit);
  const renewalRetryMillis = Math.min(10 * 60_000, policy.renewMillis);
  const renewalKey = (id: string) => `${id}:renewal`;
  const index = (state: InvocationSnapshot, id: string, listing: ToolListing, at: number) =>
    search
      .write(state, ToolSearchListing.make(id), listing, at)
      .pipe(Effect.catchCause(() => Effect.logWarning("Tool search rows were not saved")));
  const renewal = (
    id: string,
    state: InvocationSnapshot,
    started: number,
    failure?: AppEvaluationFailed | AppProviderFailed,
  ) =>
    cache.set(renewalKey(id), {
      kind: "value",
      app: state.app.id,
      at: started,
      value: new Renewal(failure),
      bytes: 0,
    });
  const readAt = (
    state: InvocationSnapshot,
    evaluate: Evaluate,
    read: ListingRead = {},
    earlier?: PendingLoad,
  ) =>
    Effect.gen(function* () {
      const identity = { app: state.app.id, version: state.version.id };
      const evaluated = (
        read.resolved === undefined
          ? resolve(state, options.resolveAccount)
          : Effect.succeed(read.resolved)
      ).pipe(Effect.flatMap(evaluate));
      const now = yield* Clock.currentTimeMillis;
      if (policy.maxStaleMillis <= 0) return { listing: yield* evaluated, at: now };
      const id = yield* options.declarations.key("tools.list", state);
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

      const keep = (outcome: Outcome, load: PendingLoad) =>
        Effect.gen(function* () {
          if (outcome instanceof Evaluated) {
            yield* Effect.annotateCurrentSpan(outcome.sizes);
            if (read.retain !== false && !partial(outcome.listed.listing.routers))
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
          if (outcome.error._tag === "AppEvaluationFailed" && refusedHostApi(outcome.error.failure))
            return;
          const current = yield* cache.get(id);
          if (
            current?.kind === "value" &&
            current.value instanceof Listed &&
            outcome.at - current.at < policy.maxStaleMillis
          )
            return;
          yield* cache.set(id, {
            kind: "value",
            app: state.app.id,
            at: load.started,
            value: outcome,
            bytes: 0,
          });
        });
      const store = (outcome: Outcome, load: PendingLoad) =>
        outcome instanceof Evaluated && !partial(outcome.listed.listing.routers)
          ? options.declarations
              .persist(
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
              .pipe(Effect.andThen(index(state, id, outcome.listed.listing, load.started)))
          : Effect.void;
      const unwatched = (load: PendingLoad) =>
        Effect.gen(function* () {
          yield* Effect.sleep(policy.loadMillis);
          if (load.waiters > 0) yield* load.unwatched.await;
          const at = yield* Clock.currentTimeMillis;
          return new Failed(timedOut(at - load.started, false), at) as Outcome;
        });
      const run = (load: PendingLoad, owner: "host" | "reader") =>
        evaluated.pipe(
          Effect.flatMap((listing) =>
            Effect.sync((): Outcome => new Evaluated(shareListing(listing))).pipe(
              Effect.withSpan("sdk.tools.listing.share"),
            ),
          ),
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
              if (Exit.isSuccess(exit)) return yield* load.done.settle(exit.value);
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
          Effect.flatMap((outcome) => store(outcome, load)),
          Effect.ensuring(Effect.sync(() => cache.end(id, load))),
          Effect.withSpan("sdk.tools.listing.evaluate"),
          Effect.interruptible,
        );
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
      const outcome = (value: unknown, at: number) =>
        Effect.gen(function* () {
          if (value instanceof Evaluated) return { listing: value.listed.listing, at };
          if (value instanceof Failed || value instanceof Unkept)
            return yield* Effect.fail(value.error);
          const elapsed = value instanceof Stopped ? value.elapsedMs : 0;
          return yield* Effect.fail(timedOut(elapsed, false));
        });
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
          return yield* outcome(done.value, load.started);
        });

      const refreshes = read.refreshStale !== false;
      const servable = (at: number) =>
        (read.newerThan === undefined || at > read.newerThan) &&
        (now - at < policy.freshMillis ||
          (now - at < policy.maxStaleMillis && (background !== undefined || !refreshes)));
      const serve = (at: number, listed: Listed, source: "memory" | "durable") =>
        Effect.gen(function* () {
          yield* authorize;
          const stale = now - at >= policy.freshMillis;
          yield* Effect.annotateCurrentSpan({
            "executor.declarations.cache": stale ? "stale" : "hit",
            "executor.declarations.source": source,
            "executor.declarations.age_ms": now - at,
          });
          if (stale && refreshes) yield* refresh;
          return { listing: listed.listing, at };
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
      if (read.followChanges !== false) yield* options.declarations.followChanges(state.app.id);
      const early = yield* keptListing;
      if (early?.value instanceof Listed && servable(early.at))
        return yield* serve(early.at, early.value, "memory");
      const before = cache.pending(id) ?? earlier;
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
        refreshes ? Effect.timeoutOption(durableHeadStartMillis) : Effect.map(Option.some),
      );
      if (Option.isSome(recalled) && recalled.value !== undefined)
        return yield* serve(recalled.value.at, recalled.value.listed, "durable");
      const orRecalled = <E, R>(evaluation: Effect.Effect<Served, E, R>) =>
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
      const kept = yield* keptListing;
      if (kept?.value instanceof Listed && servable(kept.at))
        return yield* serve(kept.at, kept.value, "memory");
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
      const shared = (load: PendingLoad | undefined) =>
        load === undefined || (load.done.isSettled() && cache.outdated(state.app.id, load.started))
          ? undefined
          : load;
      const running = shared(cache.pending(id));
      const ended = shared(before);
      if (running === undefined && ended !== undefined) {
        yield* Effect.annotateCurrentSpan("executor.declarations.cache", "joined");
        return yield* join(ended);
      }
      if (running !== undefined) {
        const elapsed = now - running.started;
        const bound = read.reportRunningAfterMillis;
        if (
          bound !== undefined &&
          !running.done.isSettled() &&
          (running.overdue || elapsed >= bound)
        ) {
          yield* authorize;
          yield* Effect.annotateCurrentSpan("executor.declarations.cache", "running");
          return yield* Effect.fail(timedOut(elapsed, true));
        }
        yield* Effect.annotateCurrentSpan("executor.declarations.cache", "joined");
        return yield* orRecalled(join(running));
      }
      const load = pendingLoad(now);
      cache.begin(id, load);
      yield* Effect.annotateCurrentSpan("executor.declarations.cache", "miss");
      const detached =
        background === undefined
          ? false
          : yield* Effect.uninterruptible(background(run(load, "host")));
      if (detached) return yield* orRecalled(join(load));
      load.waiters = 1;
      yield* run(load, read.hosted === true ? "host" : "reader");
      return yield* outcome(yield* load.done.await, load.started);
    }).pipe(
      Effect.withSpan("sdk.tools.listing", {
        attributes: { "executor.app.id": state.app.id },
      }),
    );
  const renew = (
    state: InvocationSnapshot,
    id: string,
    listing: ToolSearchListing,
    evaluate: Evaluate,
    rows: number,
    failure: AppEvaluationFailed | AppProviderFailed | undefined,
  ) =>
    Effect.gen(function* () {
      if (background === undefined || cache.pending(id) !== undefined) return;
      if (!cache.renewing()) return;
      const work = Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        yield* renewal(id, state, started, failure);
        yield* readAt(state, evaluate, {
          refreshStale: false,
          retain: false,
          hosted: true,
          newerThan: rows,
        }).pipe(
          Effect.timeoutOption(policy.loadMillis),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (found) =>
                found.at >= started
                  ? Effect.void
                  : search.write(state, listing, found.listing, found.at).pipe(Effect.ignore),
            }),
          ),
          Effect.catch((error) =>
            error._tag === "AppEvaluationFailed" || error._tag === "AppProviderFailed"
              ? renewal(id, state, started, error)
              : Effect.void,
          ),
        );
      }).pipe(
        Effect.ensuring(Effect.sync(cache.renewed)),
        Effect.withSpan("sdk.tools.searchable.renewal", {
          attributes: { "executor.app.id": state.app.id },
        }),
      );
      if (!(yield* background(work))) cache.renewed();
    });
  const searchablePrefetch = (owner: OwnerId, states: ReadonlyArray<InvocationSnapshot>) =>
    Effect.gen(function* () {
      if (policy.maxStaleMillis <= 0 || states.length === 0)
        return states.map((): SearchableAhead | undefined => undefined);
      const reads = yield* Effect.forEach(states, (state) =>
        Effect.map(options.declarations.key("tools.list", state), (id) => ({
          state,
          listing: ToolSearchListing.make(id),
          running: cache.pending(id),
        })),
      );
      yield* Effect.forEach(
        new Set(states.map((state) => state.app.id)),
        (app) => options.declarations.followChanges(app),
        { concurrency: "unbounded", discard: true },
      );
      const [kept, access] = yield* Effect.all(
        [search.listings(reads), options.declarations.authorizeAll(owner, states)],
        { concurrency: "unbounded" },
      );
      return reads.map(({ running }, index): SearchableAhead | undefined => {
        const outcome = access[index];
        return outcome === undefined ? undefined : { running, kept: kept[index], access: outcome };
      });
    }).pipe(Effect.withSpan("sdk.tools.searchable.prefetch"));
  return {
    searchablePrefetch,
    hostApi: options.declarations.hostApi,
    read: (state: InvocationSnapshot, evaluate: Evaluate, read: ListingRead = {}) =>
      readAt(state, evaluate, read).pipe(Effect.map(({ listing }) => listing)),
    kept: (state: InvocationSnapshot) =>
      Effect.gen(function* () {
        if (policy.maxStaleMillis <= 0) return Effect.succeed<ToolListing | undefined>(undefined);
        const id = yield* options.declarations.key("tools.list", state);
        const fresh = (at: number) =>
          Clock.currentTimeMillis.pipe(
            Effect.map(
              (now) => now - at < policy.maxStaleMillis && !cache.outdated(state.app.id, at),
            ),
          );
        const memory = yield* cache.get(id);
        if (memory?.kind === "value" && memory.value instanceof Listed && (yield* fresh(memory.at)))
          return Effect.succeed<ToolListing | undefined>(memory.value.listing);
        const beyond: Effect.Effect<ToolListing | undefined> = options.declarations
          .recall(state.app.id, id)
          .pipe(
            Effect.flatMap((recalled) =>
              recalled === undefined
                ? Effect.succeed(undefined)
                : Effect.flatMap(fresh(recalled.at), (servable) =>
                    servable
                      ? decodeListing(recalled.json).pipe(
                          Effect.option,
                          Effect.map(Option.getOrUndefined),
                        )
                      : Effect.succeed(undefined),
                  ),
            ),
            Effect.tap((listing) =>
              Effect.annotateCurrentSpan("executor.declarations.recalled", listing !== undefined),
            ),
            Effect.withSpan("sdk.tools.listing.recall", {
              attributes: { "executor.app.id": state.app.id },
            }),
          );
        return beyond;
      }).pipe(
        Effect.withSpan("sdk.tools.listing.kept", {
          attributes: { "executor.app.id": state.app.id },
        }),
      ),
    searchable: (
      state: InvocationSnapshot,
      evaluate: Evaluate,
      read: ListingRead = {},
      ahead?: SearchableAhead,
    ) =>
      Effect.gen(function* () {
        const id = yield* options.declarations.key("tools.list", state);
        const listing = ToolSearchListing.make(id);
        const now = yield* Clock.currentTimeMillis;
        const running = ahead === undefined ? cache.pending(id) : ahead.running;
        if (ahead === undefined) yield* options.declarations.followChanges(state.app.id);
        const [kept, access] =
          policy.maxStaleMillis <= 0
            ? ([undefined, undefined] as const)
            : ahead !== undefined
              ? ([ahead.kept, ahead.access] as const)
              : yield* Effect.all(
                  [
                    search.listing(state, listing),
                    Effect.result(options.declarations.authorize(state)),
                  ],
                  { concurrency: "unbounded" },
                );
        yield* Effect.annotateCurrentSpan("executor.search.read_ahead", ahead !== undefined);
        if (
          ahead !== undefined &&
          access !== undefined &&
          Result.isFailure(access) &&
          Schema.is(OAuthReconnectRequired)(access.failure)
        )
          return yield* Effect.fail(reconnectReported(state)(access.failure));
        const gated: Evaluate = (context) =>
          Effect.gen(function* () {
            const queued = yield* Clock.currentTimeMillis;
            return yield* searchFillGate.withPermits(1)(
              Effect.gen(function* () {
                yield* Effect.annotateCurrentSpan({
                  "executor.search.fill.wait_ms": (yield* Clock.currentTimeMillis) - queued,
                  "executor.search.fill.limit": searchFillLimit,
                });
                return yield* evaluate(context);
              }),
            );
          }).pipe(Effect.withSpan("sdk.tools.searchable.cold-fill"));
        const memory = yield* cache.get(id);
        const newer =
          memory?.kind === "value" &&
          memory.value instanceof Listed &&
          kept !== undefined &&
          memory.at > kept.at;
        if (
          kept !== undefined &&
          access !== undefined &&
          now - kept.at < policy.maxStaleMillis &&
          !cache.outdated(state.app.id, kept.at) &&
          !newer &&
          !partial(kept.routers)
        ) {
          yield* Effect.fromResult(access);
          if (kept.superseded === null || (yield* search.revive(listing))) {
            const aged = now - kept.at >= policy.renewMillis;
            const last = yield* cache.get(renewalKey(id));
            const renewed =
              last?.kind === "value" && last.value instanceof Renewal && last.at > kept.at
                ? { at: last.at, failure: last.value.failure }
                : undefined;
            yield* Effect.annotateCurrentSpan({
              "executor.search.rows": aged ? "aged" : "kept",
              "executor.search.rows.age_ms": now - kept.at,
            });
            if (aged && (renewed === undefined || now - renewed.at >= renewalRetryMillis))
              yield* renew(state, id, listing, evaluate, kept.at, renewed?.failure);
            return {
              listing,
              routers: kept.routers,
              ...(renewed?.failure === undefined
                ? {}
                : { stale: { listedAt: kept.at, failure: renewed.failure } }),
            };
          }
        }
        yield* Effect.annotateCurrentSpan(
          "executor.search.rows",
          kept === undefined
            ? "missing"
            : kept.superseded !== null
              ? "removed"
              : partial(kept.routers)
                ? "partial"
                : "stale",
        );
        const found = yield* readAt(state, gated, { ...read, retain: false }, running);
        yield* search
          .write(state, listing, found.listing, found.at)
          .pipe(
            Effect.mapError(
              () => new ToolSearchUnavailable({ app: state.app.id, reason: "unsaved" }),
            ),
          );
        return { listing, routers: found.listing.routers };
      }).pipe(
        Effect.withSpan("sdk.tools.searchable", {
          attributes: { "executor.app.id": state.app.id },
        }),
      ),
  };
};
export type Listings = ReturnType<typeof makeListings>;
