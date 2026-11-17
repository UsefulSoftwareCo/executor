/** Hosted webhook sources and subscriptions through the public API. */
import { expect } from "@effect/vitest";
import { Clock, Deferred, Effect, Schema } from "effect";
import { Api, body, type Session } from "./api.ts";
import { axiomQueryMs } from "./axiom.ts";
import { collectorReadMs, Evidence, Telemetry } from "./evidence.ts";
import { Target } from "./platform.ts";
import { ScenarioDeadline } from "./scenario-deadline.ts";
import {
  reconcileSpan,
  sourcesSpan,
  type SweepPace,
  sweepSpan,
  waitOnSweep,
} from "./webhook-sweep.ts";

/**
 * One account linked to an app as its webhook source, as the caller may see it. An account with an
 * app link is its source without an actor, even when members also link it.
 */
export const WebhookSourceRow = Schema.Struct({
  account: Schema.String,
  actor: Schema.NullOr(Schema.String),
  label: Schema.String,
  config: Schema.Record(Schema.String, Schema.Unknown),
  status: Schema.String,
  failure: Schema.NullOr(Schema.String),
});
export type WebhookSourceRow = typeof WebhookSourceRow.Type;

/** A webhook subscription's safe metadata; an app-account webhook has no actor. */
export const WebhookSubscriptionRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  actor: Schema.NullOr(Schema.String),
  sourceAccount: Schema.String,
  callbackUrl: Schema.String,
  status: Schema.String,
  failure: Schema.NullOr(Schema.String),
});
export type WebhookSubscriptionRow = typeof WebhookSubscriptionRow.Type;

/** The webhook sources of the app at `appPath` that `actor` may see. */
export const webhookSources = (actor: Session, appPath: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const response = yield* api.request(actor, "GET", `${appPath}/webhook-sources`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return yield* body(Schema.Array(WebhookSourceRow), response);
  });

/** The webhook subscriptions of the app at `appPath` that `actor` may see. */
export const webhookSubscriptions = (actor: Session, appPath: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const response = yield* api.request(actor, "GET", `${appPath}/webhooks`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return yield* body(Schema.Array(WebhookSubscriptionRow), response);
  });

/** The app ID in an app path, `/api/organizations/<org>/apps/<app>`. */
const appOf = (appPath: string) => appPath.split("/apps/")[1]?.split("/")[0] ?? "";

/**
 * How often the waits read, per target. The product is read every 250 ms. Spans come from Axiom
 * on a deployed stage: measured on 16 November's test stages, a span was readable a median
 * 0.05-0.7 s and at most 18 s after it ended, and every query counts against the organization's
 * 1,800 a minute (`x-ratelimit-limit`), shared with all its other readers, so passes are read every
 * 10 s there. A local collector receives a span within its exporter's 1 s interval and costs no
 * quota. Each `queryMs` is the reader's own time-out, so no span read runs past the report.
 */
export const deployedPace: SweepPace = {
  readSpacingMs: 250,
  spanSpacingMs: 10_000,
  deliveryMs: 20_000,
  queryMs: axiomQueryMs,
  reportMarginMs: 3_000,
  servers: "own",
};
export const localPace: SweepPace = {
  readSpacingMs: 250,
  spanSpacingMs: 2_000,
  deliveryMs: 5_000,
  queryMs: collectorReadMs,
  reportMarginMs: 3_000,
  servers: "shared",
};
/** Each Cloud environment has its own collector; see `skippingPass`. */
export const managedCloudPace: SweepPace = { ...localPace, servers: "own" };

/** The pace for a run's target: a deployed stage, a managed Cloud, or a self-hosted or local one. */
export const sweepPaceFor = (metadata: {
  readonly target: string;
  readonly mode?: string | undefined;
}): SweepPace =>
  metadata.target !== "cloud"
    ? localPace
    : metadata.mode === "attached"
      ? deployedPace
      : managedCloudPace;

/**
 * Read `attempt` until it is settled while the webhook source sweep can still reach the app's
 * pending sources; see `waitOnSweep` in `webhook-sweep.ts`. It passes on the product's read alone;
 * the sweep's spans only make it fail sooner, on a pass that skipped a source.
 */
const waitOnAppSweep = <A, E, R>(
  actor: Session,
  appPath: string,
  what: string,
  attempt: Effect.Effect<
    { readonly done: boolean; readonly value: A; readonly shown: string },
    E,
    R
  >,
) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence,
      telemetry = yield* Telemetry,
      target = yield* Target;
    const deadline = yield* ScenarioDeadline;
    const app = appOf(appPath);
    const minutesSince = (since: number) =>
      Effect.map(Clock.currentTimeMillis, (now) => (now - since) / 60_000);
    const pace = sweepPaceFor(target.metadata);
    return yield* waitOnSweep({
      what,
      deadline,
      pace,
      reads: {
        attempt,
        pending: Effect.gen(function* () {
          const sources = yield* webhookSources(actor, appPath);
          const read = (yield* evidence.requests).at(-1);
          return {
            accounts: sources.filter((source) => source.status === "pending"),
            shown: sources.map(({ account, label, status, failure }) => ({
              account,
              label,
              status,
              failure,
            })),
            trace: read?.traceId,
          };
        }),
        passes: (since) =>
          minutesSince(since).pipe(
            Effect.flatMap((minutes) => telemetry.searchRecent(sweepSpan, {}, minutes)),
            Effect.map((found) => found.data),
          ),
        served: (account, since) =>
          minutesSince(since).pipe(
            Effect.flatMap((minutes) =>
              telemetry.searchRecent(
                reconcileSpan,
                { "executor.app.id": app, "executor.account.id": account },
                minutes,
              ),
            ),
            Effect.map((found) => found.data),
          ),
        readSpan: (trace) =>
          telemetry
            .search(sourcesSpan, { traces: [trace] })
            .pipe(Effect.map((found) => found.data[0]?.span)),
      },
    });
  });

/**
 * Wait for background registration until `settled` accepts the sources `actor` sees, and return
 * them; see `waitOnAppSweep` for when it gives up.
 */
export const settleWebhookSources = (
  actor: Session,
  appPath: string,
  settled: (sources: readonly WebhookSourceRow[]) => boolean,
) =>
  waitOnAppSweep(
    actor,
    appPath,
    "Webhook sources",
    Effect.map(webhookSources(actor, appPath), (sources) => ({
      done: settled(sources),
      value: sources,
      shown: JSON.stringify(sources),
    })),
  );

/** Exactly these accounts are sources, each in the given status and failure. */
export const sourcesAre =
  (
    expected: Readonly<
      Record<string, { readonly status: string; readonly failure: string | null }>
    >,
  ) =>
  (sources: readonly WebhookSourceRow[]) =>
    sources.length === Object.keys(expected).length &&
    sources.every(
      (source) =>
        Object.hasOwn(expected, source.account) &&
        expected[source.account]?.status === source.status &&
        expected[source.account]?.failure === source.failure,
    );

/**
 * Wait for background registration until `settled` accepts the subscriptions `actor` sees, and
 * return them; their source's reconciliation registers them, so it waits on the sweep as
 * `settleWebhookSources` does.
 */
export const settleWebhookSubscriptions = (
  actor: Session,
  appPath: string,
  settled: (subscriptions: readonly WebhookSubscriptionRow[]) => boolean,
) =>
  waitOnAppSweep(
    actor,
    appPath,
    "Webhook subscriptions",
    Effect.map(webhookSubscriptions(actor, appPath), (subscriptions) => ({
      done: settled(subscriptions),
      value: subscriptions,
      shown: JSON.stringify(subscriptions),
    })),
  );

/**
 * Remove the app at `appPath` once its webhook subscriptions have stopped: removal is refused
 * while any still runs, and the sweep's reconciliation of its sources stops them. Waits on the
 * sweep as `settleWebhookSources` does.
 */
export const removeAppWhenStopped = (actor: Session, appPath: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    return yield* waitOnAppSweep(
      actor,
      appPath,
      "App removal",
      Effect.map(api.request(actor, "DELETE", appPath), (removed) => ({
        done: removed.status !== 409,
        value: removed.status,
        shown: JSON.stringify(removed.body ?? null),
      })),
    );
  });

const isConflict = Schema.is(Schema.Struct({ _tag: Schema.Literal("WebhookConflict") }));

/** How often, and for how long, confirming a removal waits out a pass that holds the subscription. */
const confirmRetry = { spacingMs: 500, leaseMs: 60_000 } as const;

/**
 * Confirm that a disabled subscription was removed at its provider. While a removal pass holds the
 * subscription, or it changed since it was read, the API answers `WebhookConflict` (409), whose
 * documented answer is to read again and retry. This retries on that alone, every 500 ms for at
 * most one webhook lease (60 s), as organization removal does for `webhooks.remove`; a
 * subscription that never becomes confirmable still fails the caller's assertion. `conflicted`,
 * when given, completes on the first conflict. Returns the last response and the conflicts taken.
 */
export const confirmWebhookRemoval = (
  actor: Session,
  appPath: string,
  subscription: string,
  conflicted?: Deferred.Deferred<void>,
) =>
  Effect.gen(function* () {
    const api = yield* Api;
    let conflicts = 0;
    while (true) {
      const response = yield* api.request(
        actor,
        "POST",
        `${appPath}/webhooks/${subscription}/confirm-removal`,
      );
      const conflict = response.status === 409 && isConflict(response.body);
      if (!conflict || conflicts >= confirmRetry.leaseMs / confirmRetry.spacingMs)
        return { response, conflicts };
      conflicts += 1;
      if (conflicted !== undefined) yield* Deferred.succeed(conflicted, undefined);
      yield* Effect.sleep(confirmRetry.spacingMs);
    }
  });
