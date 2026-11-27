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

export const WebhookSourceRow = Schema.Struct({
  account: Schema.String,
  actor: Schema.NullOr(Schema.String),
  label: Schema.String,
  config: Schema.Record(Schema.String, Schema.Unknown),
  status: Schema.String,
  failure: Schema.NullOr(Schema.String),
});
export type WebhookSourceRow = typeof WebhookSourceRow.Type;

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

export const webhookSources = (actor: Session, appPath: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const response = yield* api.request(actor, "GET", `${appPath}/webhook-sources`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return yield* body(Schema.Array(WebhookSourceRow), response);
  });

export const webhookSubscriptions = (actor: Session, appPath: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const response = yield* api.request(actor, "GET", `${appPath}/webhooks`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return yield* body(Schema.Array(WebhookSubscriptionRow), response);
  });

const appOf = (appPath: string) => appPath.split("/apps/")[1]?.split("/")[0] ?? "";

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
export const managedCloudPace: SweepPace = { ...localPace, servers: "own" };

export const sweepPaceFor = (metadata: {
  readonly target: string;
  readonly mode?: string | undefined;
}): SweepPace =>
  metadata.target !== "cloud"
    ? localPace
    : metadata.mode === "attached"
      ? deployedPace
      : managedCloudPace;

export const settleOnSweep = <A, E, R>(
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

export const settleWebhookSources = (
  actor: Session,
  appPath: string,
  settled: (sources: readonly WebhookSourceRow[]) => boolean,
) =>
  settleOnSweep(
    actor,
    appPath,
    "Webhook sources",
    Effect.map(webhookSources(actor, appPath), (sources) => ({
      done: settled(sources),
      value: sources,
      shown: JSON.stringify(sources),
    })),
  );

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

export const settleWebhookSubscriptions = (
  actor: Session,
  appPath: string,
  settled: (subscriptions: readonly WebhookSubscriptionRow[]) => boolean,
) =>
  settleOnSweep(
    actor,
    appPath,
    "Webhook subscriptions",
    Effect.map(webhookSubscriptions(actor, appPath), (subscriptions) => ({
      done: settled(subscriptions),
      value: subscriptions,
      shown: JSON.stringify(subscriptions),
    })),
  );

export const removeAppWhenStopped = (actor: Session, appPath: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    return yield* settleOnSweep(
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

const confirmRetry = { spacingMs: 500, leaseMs: 60_000 } as const;

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
