// Autumn surface: read the usage events the target ACTUALLY tracked to its
// billing backend. Metering is fire-and-forget (the engine decorator forks the
// `autumn.track` call so billing can't stall a user-facing execution), so "this
// execution was billed" is an eventually-consistent fact that lives in Autumn's
// ledger, not in the execution's own response. This surface reads that ledger
// from the suite's Autumn emulator: the layer where a "we silently stopped
// metering" regression (the unmetered MCP plane these scenarios pin) is actually
// observable. A missing track looks identical to health from the product side,
// so the contract has to be pinned where the usage is read.
import { Effect, Schedule } from "effect";

/** One usage event Autumn recorded: a `track` of `value` units of `featureId`
 *  for `customerId` (the organization the execution ran under). */
export interface UsageEvent {
  readonly customerId: string;
  readonly featureId: string;
  readonly value: number;
}

export interface UsageQuery {
  /** The Autumn customer — the organization id the metered work ran under. */
  readonly customerId: string;
  /** The metered feature, e.g. "executions". */
  readonly featureId: string;
}

export interface AutumnSurface {
  /** One-shot read of the matching usage events from the ledger. */
  readonly usageEvents: (query: UsageQuery) => Effect.Effect<readonly UsageEvent[], unknown>;
  /** Poll until at least `count` matching events have landed. The track is
   *  forked and the worker drains it on `waitUntil` shortly after the execution
   *  returns, so arrival is eventually-consistent — polling IS the contract:
   *  "the execution reaches the meter, soon". */
  readonly expectUsage: (
    query: UsageQuery & { readonly count: number },
  ) => Effect.Effect<readonly UsageEvent[], unknown>;
}

export const makeAutumnSurface = (autumnUrl: string): AutumnSurface => {
  const usageEvents = (query: UsageQuery) =>
    Effect.gen(function* () {
      // The emulator's ledger endpoint returns every recorded track event;
      // filter to this customer + feature. (autumn-js drives /v1/* RPC-style.)
      const response = yield* Effect.promise(() =>
        fetch(`${autumnUrl}/v1/events.list`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      if (!response.ok) {
        return yield* Effect.fail(
          `autumn events.list responded ${response.status}: ${yield* Effect.promise(() => response.text())}`,
        );
      }
      const body = (yield* Effect.promise(() => response.json())) as {
        readonly list?: ReadonlyArray<{
          readonly customer_id: string;
          readonly feature_id: string;
          readonly value: number;
        }>;
      };
      return (body.list ?? [])
        .filter(
          (event) => event.customer_id === query.customerId && event.feature_id === query.featureId,
        )
        .map((event) => ({
          customerId: event.customer_id,
          featureId: event.feature_id,
          value: event.value,
        }));
    });

  return {
    usageEvents,
    expectUsage: (query) =>
      usageEvents(query).pipe(
        Effect.filterOrFail(
          (events) => events.length >= query.count,
          (events) =>
            `only ${events.length}/${query.count} '${query.featureId}' usage events for ${query.customerId}`,
        ),
        // ~20s ceiling (40 x 500ms): the forked track drains on the worker's
        // waitUntil shortly after the execution returns; slower is a real bug.
        Effect.retry(Schedule.both(Schedule.spaced("500 millis"), Schedule.recurs(40))),
      ),
  };
};
