/**
 * The webhook source sweep as its spans show it, and the wait that reads it. The SDK's `tick` is
 * one pass: an `sdk.webhooks.sweep` span that records how many pending sources it took (`taken`)
 * and the most it may take (`limit`), with one `sdk.webhooks.reconcileSource` span per source it
 * reconciles. Passes run one after another (one worker on a self-hosted server, one coordinator
 * on Cloud) and take pending, unleased sources first in, first out, so a pass that started while a
 * source was pending and unleased, and took fewer than its limit, took that source.
 *
 * Spans may only make a wait fail sooner, on a proven skip. A wait never needs them to pass: it
 * passes on the product's own read, and a span read that fails or comes late only leaves the wait
 * to its bound.
 */
import { Clock, Effect } from "effect";
import type { SpanQuery } from "./contracts.ts";

export const sweepSpan = "sdk.webhooks.sweep";
export const reconcileSpan = "sdk.webhooks.reconcileSource";
/** The SDK's read of an app's sources, in the trace of the product request that read them. */
export const sourcesSpan = "sdk.webhooks.sources";
/**
 * The SDK's webhook source service that ran a pass or a read of an app's sources: one per
 * self-hosted server, one per Worker on Cloud.
 */
export const instanceTag = "executor.webhooks.instance";

export type Delivered = (typeof SpanQuery.Type)["data"][number];
export type DeliveredSpan = Delivered["span"];

export const spanStart = (span: DeliveredSpan) => Date.parse(span.startTime);
export const spanEnd = (span: DeliveredSpan) => spanStart(span) + span.durationMs;
export const sweepTaken = (span: DeliveredSpan) =>
  Number(span.tags["executor.webhooks.sweep.taken"] ?? Number.NaN);
export const sweepLimit = (span: DeliveredSpan) =>
  Number(span.tags["executor.webhooks.sweep.limit"] ?? Number.NaN);
/** A pass that took fewer pending sources than its limit, so it left none behind. */
export const hasRoom = (span: DeliveredSpan) => sweepTaken(span) < sweepLimit(span);

const byStart = (a: Delivered, b: Delivered) => spanStart(a.span) - spanStart(b.span);

/** A product read that showed the source pending, on the server's clock. */
export interface PendingRead {
  readonly start: number;
  readonly end: number;
  /** The webhook source service that answered it (`executor.webhooks.instance`). */
  readonly instance: string | undefined;
}

/**
 * The first pass that skipped the source, from the source's own history: a pass of the read's own
 * server that had room, reconciled nothing of the source's, and started after a read that showed
 * the source pending, with no reconciliation
 * of the source between that read and the pass. A reconciliation that ends after the read began
 * may have served the source and left it ready, so the source could have been queued again only
 * after the pass started; that read then proves nothing, and a later one is needed.
 *
 * `servedReadAt` is when the source's reconciliations were read: a pass is judged only once
 * `deliveryMs` has passed since it ended, so every reconciliation before it has been delivered.
 *
 * Limit: a source whose reconciliation was cut off, its server killed mid-reconcile, keeps its
 * lease (120 s, set in the SDK's `reconcile`) and still reads pending; a pass with room cannot
 * take it until the lease ends, and this judges that pass a skip. No scenario settles such a
 * source today. One that does must wait out the lease before using these waits, or this must
 * first learn the lease from the product.
 *
 * `servers: "shared"` is for a collector other servers may feed, as several self-hosted servers in
 * one job do: a pass counts only if the service that ran it answered the read. Each Cloud
 * environment has its own collector, and a deployed stage's spans are read by its stage, so there
 * (`"own"`) every pass is of the read's own coordinator, though another Worker answered the read.
 */
export const skippingPass = (input: {
  readonly passes: ReadonlyArray<Delivered>;
  readonly served: ReadonlyArray<Delivered>;
  readonly reads: ReadonlyArray<PendingRead>;
  readonly servedReadAt: number;
  readonly deliveryMs: number;
  readonly servers: "own" | "shared";
}) =>
  input.passes
    .filter(
      ({ span, traceId }) =>
        hasRoom(span) &&
        spanEnd(span) + input.deliveryMs <= input.servedReadAt &&
        !input.served.some((reconcile) => reconcile.traceId === traceId),
    )
    .toSorted(byStart)
    .find((pass) => {
      const start = spanStart(pass.span);
      const read = input.reads
        .filter(
          (read) =>
            read.end < start &&
            (input.servers === "own" || read.instance === pass.span.tags[instanceTag]),
        )
        .toSorted((a, b) => b.end - a.end)[0];
      return (
        read !== undefined &&
        !input.served.some(({ span }) => spanEnd(span) > read.start && spanStart(span) < start)
      );
    });

/** How the wait reads: the product every `readSpacingMs`, spans at most every `spanSpacingMs`. */
export interface SweepPace {
  readonly readSpacingMs: number;
  readonly spanSpacingMs: number;
  /** How long after a span ends it is surely readable. */
  readonly deliveryMs: number;
  /** The longest one span read may take (its own time-out); none starts closer to the bound. */
  readonly queryMs: number;
  /** Time kept before the scenario's time-out to report, from what was already read. */
  readonly reportMarginMs: number;
  /** Whether other servers may feed the same collector; see `skippingPass`. */
  readonly servers: "own" | "shared";
}

/** What the wait reads. Product reads fail the wait as they would any scenario; span reads never. */
export interface SweepReads<A, E, R, EP, RP, RS> {
  /** The scenario's condition, read from the product. */
  readonly attempt: Effect.Effect<
    { readonly done: boolean; readonly value: A; readonly shown: string },
    E,
    R
  >;
  /** The app's pending sources, from the product, and the trace of that read. */
  readonly pending: Effect.Effect<
    {
      readonly accounts: ReadonlyArray<{ readonly account: string; readonly label: string }>;
      readonly shown: unknown;
      readonly trace: string | undefined;
    },
    EP,
    RP
  >;
  /** Passes that started since a time (epoch milliseconds). */
  readonly passes: (since: number) => Effect.Effect<ReadonlyArray<Delivered>, unknown, RS>;
  /** One source's reconciliations since a time. */
  readonly served: (
    account: string,
    since: number,
  ) => Effect.Effect<ReadonlyArray<Delivered>, unknown, RS>;
  /** The span of the product's read of the app's sources in one trace, once delivered. */
  readonly readSpan: (trace: string) => Effect.Effect<DeliveredSpan | undefined, unknown, RS>;
}

interface Watched {
  readonly label: string;
  /** Test-clock time the source was first seen pending in this stretch. */
  readonly since: number;
  /** Reads that showed it pending, newest last, and their server times once read. */
  readonly reads: Array<{ readonly trace: string; readonly at: number; server?: PendingRead }>;
}

/**
 * Read `reads.attempt` until it is settled. A pending source behind full passes is queued, not
 * lost, and is waited for until `reportMarginMs` before `deadline`, which then fails with what was
 * read. A pass that skipped it (`skippingPass`) fails the wait at once, naming the pass.
 */
export const waitOnSweep = <A, E, R, EP, RP, RS>(input: {
  readonly what: string;
  readonly reads: SweepReads<A, E, R, EP, RP, RS>;
  readonly deadline: number | undefined;
  readonly pace: SweepPace;
}) =>
  Effect.gen(function* () {
    const { reads, pace, what } = input;
    const watched = new Map<string, Watched>();
    let passes: ReadonlyArray<Delivered> = [];
    let passReads = 0;
    let failedReads = 0;
    let spansReadAt = Number.NEGATIVE_INFINITY;
    /** A span read: a failure is counted and leaves the wait to the product's reads. */
    /**
     * A span read, made only while it can finish before the report is due (its own time-out,
     * `queryMs`, before the bound less `reportMarginMs`). A failure is counted and leaves the wait
     * to the product's reads.
     */
    const tolerant = <T>(read: Effect.Effect<T, unknown, RS>) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (
          input.deadline !== undefined &&
          now + pace.queryMs >= input.deadline - pace.reportMarginMs
        )
          return undefined;
        return yield* read.pipe(
          Effect.map((value): T | undefined => value),
          Effect.catchCause(() =>
            Effect.sync(() => {
              failedReads += 1;
              return undefined;
            }),
          ),
        );
      });
    const report = (shown: string, sources: unknown) =>
      JSON.stringify({
        [what]: JSON.parse(shown) as unknown,
        sources,
        pending: [...watched].map(([account, entry]) => {
          const after = passes.filter(({ span }) => spanStart(span) > entry.since);
          return {
            account,
            label: entry.label,
            passesSince: after.length,
            withRoom: after.filter(({ span }) => hasRoom(span)).length,
          };
        }),
        ...(passReads === 0 && failedReads > 0
          ? { passes: `could not be read (${failedReads} failed reads)` }
          : failedReads > 0
            ? { failedReads }
            : {}),
      });
    for (;;) {
      const current = yield* reads.attempt;
      if (current.done) return current.value;
      const pending = yield* reads.pending;
      const now = yield* Clock.currentTimeMillis;
      for (const account of watched.keys())
        if (!pending.accounts.some((source) => source.account === account)) watched.delete(account);
      for (const { account, label } of pending.accounts) {
        const entry = watched.get(account) ?? { label, since: now, reads: [] };
        watched.set(account, entry);
        if (pending.trace !== undefined) entry.reads.push({ trace: pending.trace, at: now });
        // A skip is judged from the reads just before a pass; older ones are never needed.
        if (entry.reads.length > 40) entry.reads.splice(0, entry.reads.length - 40);
      }
      if (watched.size > 0 && now - spansReadAt >= pace.spanSpacingMs) {
        spansReadAt = now;
        const earliest = Math.min(...[...watched.values()].map((entry) => entry.since));
        const read = yield* tolerant(reads.passes(earliest - 60_000));
        if (read !== undefined) {
          passes = read;
          passReads += 1;
        }
        for (const [account, entry] of watched) {
          // Only a pass with room after the source was first seen can have skipped it.
          const candidate = passes
            .filter(({ span }) => hasRoom(span) && spanStart(span) > entry.since - 60_000)
            .toSorted(byStart)[0];
          if (candidate === undefined) continue;
          const servedReadAt = yield* Clock.currentTimeMillis;
          const served = yield* tolerant(reads.served(account, entry.since - 60_000));
          if (served === undefined) continue;
          // The server times of the two reads made last before each candidate pass (by this
          // process's clock), each read once.
          const before = new Set(
            passes
              .filter(
                ({ span, traceId }) =>
                  hasRoom(span) &&
                  spanStart(span) > entry.since - 60_000 &&
                  !served.some((reconcile) => reconcile.traceId === traceId),
              )
              .flatMap(({ span }) =>
                entry.reads.filter((read) => read.at < spanStart(span)).slice(-2),
              ),
          );
          for (const read of [...before].slice(-4))
            if (read.server === undefined) {
              const span = yield* tolerant(reads.readSpan(read.trace));
              if (span !== undefined)
                read.server = {
                  start: spanStart(span),
                  end: spanEnd(span),
                  instance: span.tags[instanceTag],
                };
            }
          const skipped = skippingPass({
            passes,
            served,
            reads: entry.reads.flatMap((read) => (read.server === undefined ? [] : [read.server])),
            servedReadAt,
            deliveryMs: pace.deliveryMs,
            servers: pace.servers,
          });
          if (skipped !== undefined)
            return yield* Effect.die(
              new Error(
                `${what} did not settle: the webhook source sweep skipped ${entry.label}: its pass at ${skipped.span.startTime} (trace ${skipped.traceId}) took ${sweepTaken(skipped.span)} of its ${sweepLimit(skipped.span)} after a read showed the source pending, reconciled nothing of it, and it is still pending: ${report(current.shown, pending.shown)}`,
              ),
            );
        }
      }
      if (
        input.deadline !== undefined &&
        (yield* Clock.currentTimeMillis) >= input.deadline - pace.reportMarginMs
      )
        return yield* Effect.die(
          new Error(
            `${what} did not settle before the scenario's time-out: ${report(current.shown, pending.shown)}`,
          ),
        );
      yield* Effect.sleep(pace.readSpacingMs);
    }
  });
