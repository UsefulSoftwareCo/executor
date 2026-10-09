/** Evaluated app declarations and tool listings are metadata, served stale-while-revalidate. */
import type { Effect } from "effect";
import type { Handoff } from "../implementation/handoff.ts";

/**
 * Ages count from when the read that produced a result began, which is no earlier than the
 * inputs it evaluated. A result younger than `freshMillis` is served as is. An older one is
 * served while one background evaluation replaces it. Past `maxStaleMillis` the read evaluates
 * again first. A background evaluation that runs longer than `refreshMillis` is stopped.
 */
export const declarationFreshness = {
  freshMillis: 10_000,
  maxStaleMillis: 24 * 60 * 60_000,
  refreshMillis: 30_000,
} as const;

/**
 * How long an evaluated tool listing is reused, with the same meaning as `declarationFreshness`.
 * The app cache's `freshFor`/`staleFor` already bound how old a remote catalog behind a listing
 * can be, and a new deployment, profile revision, account selection or stored credential is a
 * different listing, so this window only bounds re-evaluation and inputs nothing else tracks,
 * such as a factory that fetches without the app cache. `maxStaleMillis` defaults to 24 hours, so
 * a listing read at least once a day is served from memory while it refreshes in the background.
 * `freshMillis` defaults to 30 s, so a busy catalog is re-evaluated in the background at most twice
 * a minute.
 *
 * `loadMillis` bounds an evaluation only while no request waits for it: a background refresh, or
 * a first listing every reader stopped waiting for. It is stopped once it has run that long with
 * no reader; a reader that waits keeps it running, so a slow app can always be listed by a caller
 * prepared to wait. It defaults to 45 s and never exceeds `maxStaleMillis`: ages count from when an
 * evaluation started, so a listing that takes longer than that could never be served. A host whose
 * background work ends sooner stops the evaluation then, and that stop is remembered as a timeout
 * too, so such a host keeps this default and a listing gets all the time the host gives it.
 *
 * A slow failure is remembered for `freshMillis` after it failed: a listing that timed out, was
 * stopped after `loadMillis` or when the host's background work ended, or failed after at least
 * `slowFailureMillis`. Reads with a
 * wait bound in that window, such as MCP discovery, report it at once while one background
 * evaluation retries; a success replaces it. Reads without a wait bound, such as the dashboard,
 * evaluate again, so a recovered upstream shows on their next read however slowly the remembered
 * failure arrived. A faster failure costs a read no more than reporting a remembered one, so it is
 * never remembered.
 */
export interface ToolListingPolicy {
  readonly freshMillis: number;
  readonly maxStaleMillis: number;
  readonly loadMillis: number;
  readonly slowFailureMillis: number;
}
export const defaultToolListingPolicy: ToolListingPolicy = {
  freshMillis: 30_000,
  maxStaleMillis: 24 * 60 * 60_000,
  loadMillis: 45_000,
  slowFailureMillis: 1_000,
};

/**
 * Memory bounds for one host process or isolate, in UTF-16 string bytes of each result's JSON
 * text. A host creates one store per process or isolate and shares it with every executor there.
 * A larger result is never retained. These defaults fit a 128 MB Cloud isolate; a server process
 * can hold a whole large catalog's listings with `processDeclarationLimits`.
 */
export interface DeclarationLimits {
  readonly entries: number;
  readonly bytes: number;
  readonly entryBytes: number;
}
export const declarationLimits: DeclarationLimits = {
  entries: 2_000,
  bytes: 16 * 1024 * 1024,
  entryBytes: 2 * 1024 * 1024,
};
/**
 * Local and self-host servers. A 7,000-tool catalog with 46 MB of JSON Schema counts 92 MB, and
 * its largest app (2,100 tools) 29 MB; objects in memory are larger than their text.
 */
export const processDeclarationLimits: DeclarationLimits = {
  entries: 2_000,
  bytes: 256 * 1024 * 1024,
  entryBytes: 64 * 1024 * 1024,
};

/**
 * One kept result. Declarations are kept as JSON text and decoded per read. A tool listing, or
 * the failure of one, is kept as the evaluated value and shared by reference: readers never
 * mutate it, and anything derived from it can live exactly as long as it does. `at` is when the
 * evaluation that produced it started. `app` lets an app cache change forget every result of that
 * app.
 */
export type KeptEntry =
  | { readonly kind: "json"; readonly app: string; readonly at: number; readonly json: string }
  | {
      readonly kind: "value";
      readonly app: string;
      readonly at: number;
      readonly value: unknown;
      readonly bytes: number;
    };

/**
 * An evaluation of one key that later readers join instead of starting another. Declaration
 * refreshes and tool listings both register here, so a key has at most one evaluation running.
 */
export interface PendingLoad {
  readonly started: number;
  /** Readers waiting for it now. While any waits, `loadMillis` does not stop it. */
  waiters: number;
  /**
   * A reader with its own wait bound gave up on it after it had run for at least half that
   * bound; later readers with a bound are told at once rather than wait for it again.
   */
  overdue: boolean;
  /**
   * Settles when the last reader stops waiting, for an evaluation that may then be stopped.
   * Readers and the evaluation may belong to different requests, so these are handoffs, which
   * resume each waiter in its own request, never Effect Deferreds.
   */
  readonly unwatched: Handoff<void>;
  /** Settles with what the evaluation left for its readers, however it ended. */
  readonly done: Handoff<unknown>;
}

/**
 * Process or isolate memory of evaluated declarations and tool listings. Keys digest every
 * evaluation input. `pending`, `begin` and `end` track the one evaluation of each key running in
 * this process.
 */
export interface DeclarationCache {
  readonly get: (key: string) => Effect.Effect<KeptEntry | undefined>;
  readonly set: (key: string, entry: KeptEntry) => Effect.Effect<void>;
  /** The evaluation of a key that is running now, if any. */
  readonly pending: (key: string) => PendingLoad | undefined;
  readonly begin: (key: string, load: PendingLoad) => void;
  readonly end: (key: string, load: PendingLoad) => void;
  /**
   * The app's cached upstream data was invalidated or explicitly refreshed at `at`, for example
   * after an MCP server announced a changed tool list. Results of
   * that app whose evaluation started no later than then are forgotten, including remembered
   * failures, and evaluations already running are not kept.
   */
  readonly changed: (app: string, at: number) => void;
  /** Whether a result of the app evaluated from `at` predates an invalidation seen here. */
  readonly outdated: (app: string, at: number) => boolean;
}

/**
 * How long a read that missed this process's store waits for the durable copy before it also
 * starts evaluating. A warm durable store answers well inside it, so a hit never evaluates; a slow
 * one, such as a Durable Object waking up, delays a miss by at most this much.
 */
export const durableHeadStartMillis = 100;

/** A result kept beyond this process: its JSON text and when the read that produced it began. */
export interface DurableEntry {
  readonly at: number;
  readonly json: string;
}

/**
 * Evaluated results kept where every process or isolate of a host reads them, under the same keys
 * as `DeclarationCache`. Values can include text derived from credentials, so a host keeps them
 * only where it already keeps the app's account-scoped cache, never in a store shared across
 * owners. An app cache invalidation must make the host forget the app's results evaluated no
 * later than then. `get` never fails: a failure or a slow store is a miss. `set` may drop a
 * result, and keeps it at most until `until`.
 */
export interface DurableDeclarations {
  readonly get: (app: string, key: string) => Effect.Effect<DurableEntry | undefined>;
  readonly set: (
    app: string,
    key: string,
    entry: DurableEntry & { readonly until: number },
  ) => Effect.Effect<void>;
}

/**
 * Starts work beside the current request and keeps it alive after the response, within the
 * host's lifetime for that request or server. It can share the request's resources, such as a
 * database connection. Succeeds with false when the host no longer accepts work, so the caller
 * can release what it reserved. Failures are the work's own responsibility. The host interrupts
 * accepted work only when that lifetime ends, never because the request that started it no
 * longer waits for it.
 */
export type BackgroundWork = (work: Effect.Effect<void>) => Effect.Effect<boolean>;
