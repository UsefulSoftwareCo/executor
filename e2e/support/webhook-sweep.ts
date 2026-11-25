import { Clock, Effect } from "effect";
import type { SpanQuery } from "./contracts.ts";

export const sweepSpan = "sdk.webhooks.sweep";
export const reconcileSpan = "sdk.webhooks.reconcileSource";
export const sourcesSpan = "sdk.webhooks.sources";
export const instanceTag = "executor.webhooks.instance";

export type Delivered = (typeof SpanQuery.Type)["data"][number];
export type DeliveredSpan = Delivered["span"];

export const spanStart = (span: DeliveredSpan) => Date.parse(span.startTime);
export const spanEnd = (span: DeliveredSpan) => spanStart(span) + span.durationMs;
export const sweepTaken = (span: DeliveredSpan) =>
  Number(span.tags["executor.webhooks.sweep.taken"] ?? Number.NaN);
export const sweepLimit = (span: DeliveredSpan) =>
  Number(span.tags["executor.webhooks.sweep.limit"] ?? Number.NaN);
export const hasRoom = (span: DeliveredSpan) => sweepTaken(span) < sweepLimit(span);

const byStart = (a: Delivered, b: Delivered) => spanStart(a.span) - spanStart(b.span);

export interface PendingRead {
  readonly start: number;
  readonly end: number;
  readonly instance: string | undefined;
}

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

export interface SweepPace {
  readonly readSpacingMs: number;
  readonly spanSpacingMs: number;
  readonly deliveryMs: number;
  readonly queryMs: number;
  readonly reportMarginMs: number;
  readonly servers: "own" | "shared";
}

export interface SweepReads<A, E, R, EP, RP, RS> {
  readonly attempt: Effect.Effect<
    { readonly done: boolean; readonly value: A; readonly shown: string },
    E,
    R
  >;
  readonly pending: Effect.Effect<
    {
      readonly accounts: ReadonlyArray<{ readonly account: string; readonly label: string }>;
      readonly shown: unknown;
      readonly trace: string | undefined;
    },
    EP,
    RP
  >;
  readonly passes: (since: number) => Effect.Effect<ReadonlyArray<Delivered>, unknown, RS>;
  readonly served: (
    account: string,
    since: number,
  ) => Effect.Effect<ReadonlyArray<Delivered>, unknown, RS>;
  readonly readSpan: (trace: string) => Effect.Effect<DeliveredSpan | undefined, unknown, RS>;
}

interface Watched {
  readonly label: string;
  readonly since: number;
  readonly reads: Array<{ readonly trace: string; readonly at: number; server?: PendingRead }>;
}

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
          const candidate = passes
            .filter(({ span }) => hasRoom(span) && spanStart(span) > entry.since - 60_000)
            .toSorted(byStart)[0];
          if (candidate === undefined) continue;
          const servedReadAt = yield* Clock.currentTimeMillis;
          const served = yield* tolerant(reads.served(account, entry.since - 60_000));
          if (served === undefined) continue;
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
