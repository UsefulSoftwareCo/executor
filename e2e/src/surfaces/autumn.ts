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

import { DEFAULT_PLAN_EXECUTIONS_INCLUDED } from "../../setup/autumn-plans";

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

/** A one-shot (or counted) fault to arm against a matching Autumn request. Mirrors
 *  the emulator's `POST /_emulate/faults` body: a request matching every provided
 *  `match` criterion short-circuits with `response`, `times` decrements per hit
 *  (default 1, removed at zero), and `delayMs` stalls before the fault returns —
 *  the knob a timeout scenario uses to push Autumn past the gate's time budget. */
export interface FaultInput {
  readonly match: {
    readonly operationId?: string;
    readonly method?: string;
    readonly pathPattern?: string;
  };
  readonly response: { readonly status: number; readonly body?: unknown };
  readonly times?: number;
  readonly delayMs?: number;
}

/** One request the emulator recorded in its ledger, narrowed to what these
 *  scenarios assert on: which operation ran and whether a fault short-circuited
 *  it. A faulted `balances.check` entry is the proof the gate actually consulted
 *  Autumn (and then failed open) rather than never checking at all. */
export interface LedgerEntry {
  readonly operationId?: string;
  readonly method: string;
  readonly path: string;
  readonly faulted: boolean;
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
  /** Land the asynchronous checkout webhook for a checkout session, activating
   *  its subscription. In production this is Stripe's `checkout.session.completed`
   *  reaching Autumn shortly after the browser is redirected back; the emulator
   *  defers activation until this is called, so a test controls the exact moment
   *  the billing backend becomes consistent. The `sessionId` is the last path
   *  segment of the hosted checkout URL the browser was sent to. */
  readonly settleCheckout: (sessionId: string) => Effect.Effect<void, unknown>;
  /** Burn an org's entire remaining "executions" balance in one `balances.track`,
   *  so the next `balances.check` reports `allowed: false`. The amount is the
   *  default plan's included allotment (read from the plan seed, never hardcoded),
   *  which drives `remaining` to zero. This is the setup a "blocked at cap"
   *  scenario runs before opening the session it expects to be gated. */
  readonly exhaustExecutions: (customerId: string) => Effect.Effect<void, unknown>;
  /** Arm a fault against a matching Autumn request (`POST /_emulate/faults`). */
  readonly armFault: (input: FaultInput) => Effect.Effect<void, unknown>;
  /** Clear every armed fault (`DELETE /_emulate/faults`) — the finalizer that
   *  keeps a scenario's fault from leaking into the next one. */
  readonly clearFaults: () => Effect.Effect<void, unknown>;
  /** Read the emulator's request ledger, filtered to one operation — used to
   *  prove a faulted `balances.check` was actually attempted (fail-open proof). */
  readonly ledgerFor: (operationId: string) => Effect.Effect<readonly LedgerEntry[], unknown>;
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

  const settleCheckout = (sessionId: string) =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        fetch(`${autumnUrl}/checkout/${encodeURIComponent(sessionId)}/settle`, { method: "POST" }),
      );
      if (!response.ok) {
        return yield* Effect.fail(
          `autumn checkout settle responded ${response.status}: ${yield* Effect.promise(() => response.text())}`,
        );
      }
    });

  // Track exactly the plan's included allotment in one event, driving
  // `remaining` (included - usage) to zero so the next check reports blocked.
  const exhaustExecutions = (customerId: string) =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        fetch(`${autumnUrl}/v1/balances.track`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            customer_id: customerId,
            feature_id: "executions",
            value: DEFAULT_PLAN_EXECUTIONS_INCLUDED,
          }),
        }),
      );
      if (!response.ok) {
        return yield* Effect.fail(
          `autumn balances.track responded ${response.status}: ${yield* Effect.promise(() => response.text())}`,
        );
      }
    });

  const armFault = (input: FaultInput) =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        fetch(`${autumnUrl}/_emulate/faults`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
      );
      if (!response.ok) {
        return yield* Effect.fail(
          `autumn arm fault responded ${response.status}: ${yield* Effect.promise(() => response.text())}`,
        );
      }
    });

  const clearFaults = () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        fetch(`${autumnUrl}/_emulate/faults`, { method: "DELETE" }),
      );
      if (!response.ok) {
        return yield* Effect.fail(
          `autumn clear faults responded ${response.status}: ${yield* Effect.promise(() => response.text())}`,
        );
      }
    });

  const ledgerFor = (operationId: string) =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() => fetch(`${autumnUrl}/_emulate/ledger`));
      if (!response.ok) {
        return yield* Effect.fail(
          `autumn ledger responded ${response.status}: ${yield* Effect.promise(() => response.text())}`,
        );
      }
      const body = (yield* Effect.promise(() => response.json())) as {
        readonly entries?: ReadonlyArray<{
          readonly operationId?: string;
          readonly method?: string;
          readonly path?: string;
          readonly faulted?: boolean;
        }>;
      };
      return (body.entries ?? [])
        .filter((entry) => entry.operationId === operationId)
        .map((entry) => ({
          operationId: entry.operationId,
          method: entry.method ?? "",
          path: entry.path ?? "",
          faulted: entry.faulted === true,
        }));
    });

  return {
    usageEvents,
    settleCheckout,
    exhaustExecutions,
    armFault,
    clearFaults,
    ledgerFor,
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
