/** Evaluated tool listings, reused across requests through the declaration store. */
import { Cause, Clock, Effect, Exit, Fiber, Option, Semaphore } from "effect";
import {
  defaultToolListingPolicy,
  durableHeadStartMillis,
  type BackgroundWork,
  type DeclarationCache,
  type PendingLoad,
  type ToolListingPolicy,
} from "../contracts/declarations.ts";
import {
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
import type { VersionId } from "../contracts/shared.ts";
import type { Declarations } from "./declarations.ts";
import { makeHandoff } from "./handoff.ts";
import { decodeListing, shareListing } from "./listing-json.ts";
import type { makeOAuth } from "./oauth.ts";
import { resolve, type InvocationSnapshot } from "./tools.ts";
import type { ToolSearch } from "./tool-search.ts";

/** Every tool of one app for one invocation state, sorted by name. */
export interface ToolListing {
  readonly catalog: {
    readonly version: VersionId;
    readonly accounts: AppAccounts;
  };
  /** Sorted by name. */
  readonly items: ReadonlyArray<Tool>;
  /** Every router in the catalog, on every page. */
  readonly routers: ReadonlyArray<ToolRouter>;
  /**
   * The JSON length of each of `items`, in UTF-16 code units, counted when the listing was kept,
   * so a page is bounded without writing its tools again. A listing evaluated for one read, or
   * read from a format 2 text, has none.
   */
  readonly itemChars?: ReadonlyArray<number>;
}

/** Failures of the evaluation itself. Credential and storage failures are never remembered. */
export type ListingFailure = AppEvaluationFailed | AppProviderFailed | ToolListingTimedOut;
type ResolveError = Effect.Error<ReturnType<typeof resolve>>;

/** A listing and when the evaluation that produced it started. */
interface Served {
  readonly listing: ToolListing;
  readonly at: number;
}

/** May renew a refused account, which fails like resolving it; such failures are not kept. */
type Evaluate = (
  context: Effect.Success<ReturnType<typeof resolve>>,
) => Effect.Effect<ToolListing, AppEvaluationFailed | AppProviderFailed | ResolveError>;

/** How an in-process caller reads a listing. */
interface ListingRead extends ToolListOptions {
  /**
   * The accounts the caller already resolved for this invocation state, such as a tool call
   * reading the tool's kind. An evaluation this read starts uses them instead of resolving the
   * accounts again, which would renew a grant inside its renewal window a second time.
   */
  readonly resolved?: Effect.Success<ReturnType<typeof resolve>>;
  /** Do not retain a decoded listing after a cold search fill writes its rows. */
  readonly retain?: boolean;
  /**
   * The read itself runs as the host's background work, such as a renewal of aged search rows.
   * An evaluation it runs in its own fiber, because the host refused it as separate background
   * work once the request was closing, is then still the host's: the host ending it is
   * remembered as a timeout, as it is for one the host accepted.
   */
  readonly hosted?: boolean;
  /**
   * Whether the read checks that what this process keeps of the app is from after its cached data
   * last changed (`followChanges`), as it does by default. A call's own read of the tool's kind
   * passes false: it runs before the call hands its work to the app, which resolves the tool
   * against its live catalog, so it sends the supervisor nothing ahead of that.
   */
  readonly followChanges?: boolean;
  /**
   * Serve no kept listing evaluated at or before this time, such as the one a renewal of search
   * rows evaluated then replaces: the read evaluates the app unless a newer listing is kept.
   */
  readonly newerThan?: number;
}

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
    this.listed = new Listed({ ...shared.listing, itemChars: shared.itemChars });
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
/**
 * A background renewal of search rows, kept beside the listing under its own key from when it
 * started. Rows evaluated before it are not renewed again until `renewalRetryMillis` after it,
 * whether it finished, failed or the host stopped it. One that failed in the app or its upstream
 * keeps that failure, which searches report beside the rows they still serve, however fast it
 * failed. It is kept in this process or isolate only.
 */
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
/** Interrupted before it finished, by its owning reader or by the host. */
class Stopped {
  readonly elapsedMs: number;
  constructor(elapsedMs: number) {
    this.elapsedMs = elapsedMs;
  }
}
type Outcome = Evaluated | Failed | Unkept | Stopped;

/**
 * Whether the app's own router failed for some of its accounts, such as one account whose MCP
 * server refused to list its tools, while the others' tools were listed. Such a listing is served
 * to the readers of its evaluation but never kept, like a failure, so the next read evaluates the
 * app again and finds a recovered account.
 */
const partial = (routers: ReadonlyArray<ToolRouter>) =>
  routers.some((router) => router.path === "" && router.error !== undefined);

/**
 * Keep each evaluated listing in the shared declaration store under the declaration key, so a
 * new version, account set or stored credential is another listing,
 * and serve anything this read did not evaluate itself only after the checks a live evaluation
 * runs before it releases credentials: a kept listing, a remembered failure, and the result of
 * an evaluation another request started.
 *
 * A listing younger than `freshMillis` is served as is; an older one is served while one
 * background evaluation replaces it, or as is to a reader that passes `refreshStale: false`; past
 * `maxStaleMillis` the read evaluates first. Readers of a
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
  readonly policy?: ToolListingPolicy;
  /** Keeps evaluated listings as search rows. */
  readonly search: ToolSearch;
}) => {
  const policy = options.policy ?? defaultToolListingPolicy;
  const { cache, background, search } = options;
  /** Cold search fills of one executor share a small gate. */
  const searchFillLimit = 2;
  const searchFillGate = Semaphore.makeUnsafe(searchFillLimit);
  /**
   * How long after a renewal of search rows starts that rows evaluated before it are renewed
   * again: a host that ends background work soon after a request may stop a slow app's renewal
   * every time, and other apps' rows still need theirs.
   */
  const renewalRetryMillis = Math.min(10 * 60_000, policy.renewMillis);
  const renewalKey = (id: string) => `${id}:renewal`;
  /**
   * Keep an evaluated listing as search rows. A failure is logged: `searchable` finds the rows
   * missing or older than the listing and writes them again before naming them.
   */
  const index = (state: InvocationSnapshot, id: string, listing: ToolListing, at: number) =>
    search
      .write(state, ToolSearchListing.make(id), listing, at)
      .pipe(Effect.catchCause(() => Effect.logWarning("Tool search rows were not saved")));
  /** Keep a renewal of `id`'s rows, stamped with its start, so an app cache change since forgets it. */
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
  /**
   * `earlier` is the evaluation that was running when the caller began reading where a listing
   * is kept outside this read, such as search rows.
   */
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

      /** Keep a listing, or a slow failure unless a listing that may still be served exists. */
      const keep = (outcome: Outcome, load: PendingLoad) =>
        Effect.gen(function* () {
          if (outcome instanceof Evaluated) {
            // What the evaluation's CPU, which a Workers I/O clock cannot time, grows with.
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
       * Keep a listing beyond this process, and as search rows. It runs after the evaluation's
       * readers have their outcome, and encodes with the write, so they never wait for it, and
       * before the evaluation leaves `pending`: a cold search fill keeps its listing nowhere else,
       * so a reader that comes meanwhile joins the finished evaluation instead of starting another.
       */
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
              // It leaves `pending` once `store` below has kept it.
              if (Exit.isSuccess(exit)) return yield* load.done.settle(exit.value);
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
          Effect.ensuring(Effect.sync(() => cache.end(id, load))),
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
      const outcome = (value: unknown, at: number) =>
        Effect.gen(function* () {
          if (value instanceof Evaluated) return { listing: value.listed.listing, at };
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
          return yield* outcome(done.value, load.started);
        });

      // A reader that refreshes a stale listing needs background work to do so; without it the
      // listing is evaluated again first, like a missing one.
      const refreshes = read.refreshStale !== false;
      const servable = (at: number) =>
        (read.newerThan === undefined || at > read.newerThan) &&
        (now - at < policy.freshMillis ||
          (now - at < policy.maxStaleMillis && (background !== undefined || !refreshes)));
      /**
       * Serve a kept listing, refreshing it in the background once it is past `freshMillis`
       * unless the reader asked not to.
       */
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
      // What this process keeps of the app from before its cached data changed is forgotten once
      // the check this starts, if one is due, reads when that was.
      if (read.followChanges !== false) yield* options.declarations.followChanges(state.app.id);
      const early = yield* keptListing;
      if (early?.value instanceof Listed && servable(early.at))
        return yield* serve(early.at, early.value, "memory");
      // What runs before this read looks beyond this process and in memory again, or, as
      // `earlier`, before its caller read search rows. An evaluation that ends keeps its listing
      // or failure there before it leaves `pending`, so reading what runs first never misses both.
      const before = cache.pending(id) ?? earlier;
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
      // A reader that does not refresh waits for the whole durable read: an evaluation beside
      // it would load the app's Worker and replace the kept listing the read then serves.
      const recalled = yield* Fiber.join(recalling).pipe(
        refreshes ? Effect.timeoutOption(durableHeadStartMillis) : Effect.map(Option.some),
      );
      if (Option.isSome(recalled) && recalled.value !== undefined)
        return yield* serve(recalled.value.at, recalled.value.listed, "durable");
      /**
       * A slow durable read, often a Durable Object waking up, would delay every miss: wait for
       * an evaluation beside it and answer with whichever settles first. A listing the read
       * finds still wins.
       */
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
      // The durable read yielded, and an evaluation may have ended meanwhile.
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
      /**
       * An evaluation a reader may share. One that finished, but started no later than an app
       * cache change seen here, listed the replaced data and was not kept, so a reader evaluates
       * again as if it had found nothing.
       */
      const shared = (load: PendingLoad | undefined) =>
        load === undefined || (load.done.isSettled() && cache.outdated(state.app.id, load.started))
          ? undefined
          : load;
      // Read again so that checking and registering below happen without yielding. Registering
      // replaces an evaluation that is not shared.
      const running = shared(cache.pending(id));
      const ended = shared(before);
      if (running === undefined && ended !== undefined) {
        // It ended after the read above: the outcome it left is there already.
        yield* Effect.annotateCurrentSpan("executor.declarations.cache", "joined");
        return yield* join(ended);
      }
      if (running !== undefined) {
        const elapsed = now - running.started;
        const bound = read.reportRunningAfterMillis;
        // One that finished and is still keeping its listing has the outcome for this reader.
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
      // Checking for a running evaluation and registering this one happen without yielding.
      const load = pendingLoad(now);
      cache.begin(id, load);
      yield* Effect.annotateCurrentSpan("executor.declarations.cache", "miss");
      const detached =
        background === undefined
          ? false
          : yield* Effect.uninterruptible(background(run(load, "host")));
      if (detached) return yield* orRecalled(join(load));
      // Without background work the evaluation belongs to this reader and stops with it, unless
      // the reader is the host's background work.
      load.waiters = 1;
      yield* run(load, read.hosted === true ? "host" : "reader");
      return yield* outcome(yield* load.done.await, load.started);
    }).pipe(
      Effect.withSpan("sdk.tools.listing", {
        attributes: { "executor.app.id": state.app.id },
      }),
    );
  /**
   * Renew search rows evaluated at `rows` in the background, only when the store admits another
   * renewal at once: renewals queued behind others would mostly wait out the host's background
   * time, the search that starts one is not waiting for it, and every executor of the process or
   * isolate shares the store, so one request cannot start a renewal for each of many apps. It evaluates the app unless a listing
   * evaluated since the rows is kept, and writes that listing's rows. Only a failure in the app or
   * its upstream is kept with it; a renewal the host stopped, that ran past `loadMillis`, or met a
   * credential or storage failure says nothing about the rows.
   */
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
        // An earlier renewal's failure is still reported while this one runs.
        yield* renewal(id, state, started, failure);
        // Nobody waits for it, so it joins a running evaluation however long that has run.
        yield* readAt(state, evaluate, {
          refreshStale: false,
          retain: false,
          hosted: true,
          newerThan: rows,
        }).pipe(
          // Nobody waits for a renewal, so it stops waiting at the load bound rather than keep a
          // stalled evaluation running.
          Effect.timeoutOption(policy.loadMillis),
          // An evaluation this renewal started kept its rows itself; a kept listing evaluated
          // since the rows, such as another isolate's, is written here. Writing an evaluated one
          // again would only wait for the first write while holding a connection.
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
  return {
    /** The host API revision this version's invocations are bound to; listings are keyed by it. */
    hostApi: options.declarations.hostApi,
    read: (state: InvocationSnapshot, evaluate: Evaluate, read: ListingRead = {}) =>
      readAt(state, evaluate, read).pipe(Effect.map(({ listing }) => listing)),
    /**
     * The listing a reader that does not refresh would be served without evaluating, in two steps:
     * the one kept in this process is read now, and the returned lookup answers with it, or, only
     * when run and none was kept here, with the one kept beyond this process. Neither evaluates the
     * app nor waits for an evaluation that is running, so neither runs the app's code. A call reads
     * the first step before it hands over its work: an app cache change it makes forgets the app's
     * kept listings. Nothing is served to a caller, so access is not checked here.
     */
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
    /**
     * Keep the listing `read` would serve as search rows, and name them. Rows evaluated within
     * `maxStaleMillis` are served at once after the checks a kept listing is, unless an app cache
     * change since or a newer listing kept here replaced them, and kept again if a newer listing
     * superseded them and cleanup has not removed them. Rows older than `renewMillis` are renewed
     * in the background while they are served; a renewal that failed in the app or its upstream is
     * reported beside them as `stale` until a later one succeeds. Otherwise the listing is read as
     * `read` does and named only once the write commits its rows, at its evaluation's time or a
     * later one. A write that fails is `ToolSearchUnavailable`: the rows that are kept, if any, are
     * not this listing's.
     */
    searchable: (state: InvocationSnapshot, evaluate: Evaluate, read: ListingRead = {}) =>
      Effect.gen(function* () {
        const id = yield* options.declarations.key("tools.list", state);
        const listing = ToolSearchListing.make(id);
        const now = yield* Clock.currentTimeMillis;
        // Read before the rows: an evaluation that ends while they are read wrote them first.
        const running = cache.pending(id);
        // Rows from before the app's cached data last changed are not served; see `followChanges`.
        yield* options.declarations.followChanges(state.app.id);
        const kept = policy.maxStaleMillis <= 0 ? undefined : yield* search.listing(state, listing);
        // Rows missing, stale or removed are filled from an evaluation through the shared gate,
        // which keeps no decoded listing: rows are what later searches read. Readers of the same
        // listing share one evaluation, which the load bound stops like any other once nobody
        // waits for it.
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
          now - kept.at < policy.maxStaleMillis &&
          !cache.outdated(state.app.id, kept.at) &&
          !newer &&
          // Written only for the search that evaluated them; see `partial`.
          !partial(kept.routers)
        ) {
          yield* options.declarations.authorize(state);
          // A superseded listing is kept again unless cleanup removed it since it was read; then
          // it is written again like a missing one.
          if (kept.superseded === null || (yield* search.revive(listing))) {
            const aged = now - kept.at >= policy.renewMillis;
            const last = yield* cache.get(renewalKey(id));
            // The latest renewal started since these rows were evaluated.
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
