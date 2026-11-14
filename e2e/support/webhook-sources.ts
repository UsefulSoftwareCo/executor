/** Hosted webhook sources and subscriptions through the public API. */
import { expect } from "@effect/vitest";
import { Clock, Deferred, Effect, Schema } from "effect";
import { Api, body, type Session } from "./api.ts";

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

/**
 * Wait for background registration until `settled` accepts the sources `actor` sees, and return
 * them. Fails with the last observed sources after 30 seconds.
 */
export const settleWebhookSources = (
  actor: Session,
  appPath: string,
  settled: (sources: readonly WebhookSourceRow[]) => boolean,
) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 30_000;
    for (;;) {
      const sources = yield* webhookSources(actor, appPath);
      if (settled(sources)) return sources;
      expect(
        yield* Clock.currentTimeMillis,
        `Webhook sources did not settle: ${JSON.stringify(sources)}`,
      ).toBeLessThan(deadline);
      yield* Effect.sleep("100 millis");
    }
  });

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
 * return them. Fails with the last observed subscriptions after 30 seconds.
 */
export const settleWebhookSubscriptions = (
  actor: Session,
  appPath: string,
  settled: (subscriptions: readonly WebhookSubscriptionRow[]) => boolean,
) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 30_000;
    for (;;) {
      const subscriptions = yield* webhookSubscriptions(actor, appPath);
      if (settled(subscriptions)) return subscriptions;
      expect(
        yield* Clock.currentTimeMillis,
        `Webhook subscriptions did not settle: ${JSON.stringify(subscriptions)}`,
      ).toBeLessThan(deadline);
      yield* Effect.sleep("100 millis");
    }
  });

/**
 * Remove the app at `appPath` once its webhook subscriptions have stopped: removal is refused
 * while any still runs, and removing sources are not listed. Fails after 30 seconds.
 */
export const removeAppWhenStopped = (actor: Session, appPath: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const deadline = (yield* Clock.currentTimeMillis) + 30_000;
    for (;;) {
      const removed = yield* api.request(actor, "DELETE", appPath);
      if (removed.status !== 409) return removed.status;
      expect(yield* Clock.currentTimeMillis, JSON.stringify(removed.body)).toBeLessThan(deadline);
      yield* Effect.sleep("100 millis");
    }
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
