/**
 * App events and their webhook subscriptions. Apps declare events in their requirements and emit
 * them from mutations and webhook handlers. A subscriber names an event, filter arguments, a
 * callback URL and a Standard Webhooks secret; Executor verifies the callback, then POSTs each
 * matching occurrence, signed, with bounded retries.
 *
 * The SDK owns storage, matching, signing and retries. Products own authorization: who may list,
 * subscribe and keep receiving. These operations are host-only and not mounted on the SDK HTTP API.
 */
import { Effect, Redacted, Schema } from "effect";
import { DeclaredEvent, EventName, EventFilterValue, type EmittedEvent } from "apps/contracts";
import { AccountId, AppId, OwnerId, ProfileId, StorageError, CredentialsError } from "./shared.ts";

/** Deterministic subscription identity: a digest of who subscribed, where to and to what. */
export const EventSubscriptionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^evs_[0-9a-f]{32}$/u)),
  Schema.brand("evs"),
);
export type EventSubscriptionId = typeof EventSubscriptionId.Type;

/** One saved occurrence; it is encrypted under this ID. */
export const StoredEventId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^evr_[\s\S]+$/u)),
  Schema.brand("evr"),
);
export type StoredEventId = typeof StoredEventId.Type;

/** Lifetimes, deadlines and retry bounds. Durations are milliseconds. */
export const EventDeliveryLimits = Schema.Struct({
  /** Granted when the subscriber suggests no lifetime. */
  defaultTtlMs: Schema.Int.check(Schema.isGreaterThan(0)),
  /** The longest lifetime granted, including for a request without expiry. */
  maxTtlMs: Schema.Int.check(Schema.isGreaterThan(0)),
  /** A shorter suggestion is raised to this, so refreshes stay infrequent. */
  minTtlMs: Schema.Int.check(Schema.isGreaterThan(0)),
  /** One verification or delivery request. */
  requestTimeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  /** A verified callback is not challenged again for the same principal within this window. */
  verificationReuseMs: Schema.Int.check(Schema.isGreaterThan(0)),
  /** After a secret changes, deliveries are also signed with the previous one for this long. */
  secretOverlapMs: Schema.Int.check(Schema.isGreaterThan(0)),
  /** Attempts per delivery, including the first. */
  maxAttempts: Schema.Int.check(Schema.isGreaterThan(0)),
  /** The delay before the second attempt; each later one doubles, up to `maxBackoffMs`. */
  firstBackoffMs: Schema.Int.check(Schema.isGreaterThan(0)),
  maxBackoffMs: Schema.Int.check(Schema.isGreaterThan(0)),
  /** A claimed delivery is retried by another runner after this. */
  leaseMs: Schema.Int.check(Schema.isGreaterThan(0)),
  /**
   * How long an event is kept. After it the event is deleted, a delivery of it still pending is
   * abandoned, and finished deliveries are deleted. It exceeds every retry schedule, so only an
   * outage this long abandons an event.
   */
  retentionMs: Schema.Int.check(Schema.isGreaterThan(0)),
  /** The largest request body: one occurrence, signed. */
  maxBodyBytes: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type EventDeliveryLimits = typeof EventDeliveryLimits.Type;
export const defaultEventDeliveryLimits = EventDeliveryLimits.make({
  defaultTtlMs: 24 * 60 * 60_000,
  maxTtlMs: 7 * 24 * 60 * 60_000,
  minTtlMs: 60_000,
  requestTimeoutMs: 10_000,
  verificationReuseMs: 24 * 60 * 60_000,
  secretOverlapMs: 5 * 60_000,
  // 5 s doubling to the 1 h cap: 14 attempts keep retrying for about four and a half hours.
  maxAttempts: 14,
  firstBackoffMs: 5_000,
  maxBackoffMs: 60 * 60_000,
  leaseMs: 60_000,
  retentionMs: 3 * 24 * 60 * 60_000,
  maxBodyBytes: 256 * 1024,
});

/** One event an app declares, as a subscriber sees it. */
export const AppEventDefinition = Schema.Struct({
  app: AppId,
  name: EventName,
  ...DeclaredEvent.fields,
});
export type AppEventDefinition = typeof AppEventDefinition.Type;

/** Arguments a subscriber filters on; each names a declared filter. */
export const EventArguments = Schema.Record(Schema.String, EventFilterValue);
export type EventArguments = typeof EventArguments.Type;

/**
 * What identifies a subscription. `principal` is the product's identifier for the authenticated
 * subscriber, such as an OAuth grant. `name` is the event name as the subscriber wrote it.
 */
export const EventSubscriptionKey = Schema.Struct({
  principal: Schema.NonEmptyString,
  callbackUrl: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  arguments: EventArguments,
});
export type EventSubscriptionKey = typeof EventSubscriptionKey.Type;

/** Subscribe, or refresh the subscription with the same key. */
export interface SubscribeEvent {
  readonly key: EventSubscriptionKey;
  /** The app and event the name refers to now. A refresh of a saved subscription keeps its own. */
  readonly target?: { readonly app: AppId; readonly event: EventName };
  /** The person the principal acts for; products recheck their access before each delivery. */
  readonly subject: string;
  /** A Standard Webhooks `whsec_` secret, chosen by the subscriber. */
  readonly secret: Redacted.Redacted<string>;
  /** Suggested lifetime; `null` asks for no expiry, which is granted as the longest lifetime. */
  readonly ttlMs?: number | null;
}

/** The server's grant. */
export interface EventSubscriptionGrant {
  readonly id: EventSubscriptionId;
  readonly refreshBefore: Date;
}

/** Saved subscription metadata. The secret is never returned. */
export const EventSubscription = Schema.Struct({
  id: EventSubscriptionId,
  owner: OwnerId,
  app: AppId,
  event: EventName,
  name: Schema.NonEmptyString,
  arguments: EventArguments,
  callbackUrl: Schema.NonEmptyString,
  principal: Schema.NonEmptyString,
  subject: Schema.String,
  status: Schema.Literals(["active", "stopped"]),
  /**
   * Why it stopped: unsubscribed, expired, access revoked, the receiver answered 410, or the
   * app no longer declares the event or the filters its arguments name.
   */
  stopped: Schema.NullOr(
    Schema.Literals(["unsubscribed", "expired", "revoked", "gone", "changed"]),
  ),
  expiresAt: Schema.Date,
  createdAt: Schema.Date,
});
export type EventSubscription = typeof EventSubscription.Type;

/** Callback failure categories, from the draft MCP events extension. They never quote a response. */
export const CallbackFailure = Schema.Literals([
  "connection_refused",
  "timeout",
  "tls_error",
  "http_4xx",
  "http_5xx",
  "challenge_failed",
]);
export type CallbackFailure = typeof CallbackFailure.Type;

/** No event with this name, or no saved subscription with this key. */
export class EventNotFound extends Schema.TaggedError<EventNotFound>()("EventNotFound", {
  kind: Schema.Literals(["event", "subscription"]),
}) {}
/** The arguments, URL or secret do not fit the event or the delivery rules. */
export class EventSubscriptionInvalid extends Schema.TaggedError<EventSubscriptionInvalid>()(
  "EventSubscriptionInvalid",
  {
    field: Schema.Literals(["arguments", "callbackUrl", "secret", "ttlMs"]),
    message: Schema.String,
  },
) {}
/**
 * A saved subscription's arguments no longer fit its event: the app removed, renamed or narrowed
 * a filter they name. The subscription is stopped; the client subscribes again from the new list.
 */
export class EventDefinitionChanged extends Schema.TaggedError<EventDefinitionChanged>()(
  "EventDefinitionChanged",
  {},
) {}
/** The callback did not verify. */
export class EventCallbackFailed extends Schema.TaggedError<EventCallbackFailed>()(
  "EventCallbackFailed",
  { reason: CallbackFailure },
) {}
/** This host has no way to send event deliveries. */
export class EventsUnavailable extends Schema.TaggedError<EventsUnavailable>()(
  "EventsUnavailable",
  {},
) {}

/** Raised by a product's authorization when the subscriber may not see this one occurrence. */
export class EventNotVisible extends Schema.TaggedError<EventNotVisible>()("EventNotVisible", {}) {}

/** Raised by a product's authorization when the subscriber may no longer receive the event. */
export class EventAccessRevoked extends Schema.TaggedError<EventAccessRevoked>()(
  "EventAccessRevoked",
  {},
) {}

/** One outbound request, signed by the SDK. The sender only transports it. */
export interface EventRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
/** The receiver's answer. `body` is bounded by the sender and read only for verification. */
export interface EventResponse {
  readonly status: number;
  readonly body: string;
}
/**
 * The host's outbound transport. It must connect only to public addresses it validated at
 * connect time, never follow redirects and give up after `timeoutMs`.
 */
export interface EventSender {
  /**
   * Send one request. Only verification reads the response body; a delivery is settled by its
   * status alone, so a receiver's slow or broken body never turns a final answer into a retry.
   */
  readonly send: (
    request: EventRequest,
    timeoutMs: number,
    options: { readonly readBody: boolean },
  ) => Effect.Effect<EventResponse, EventCallbackFailed>;
}

/** What a product checks before each delivery. */
export interface EventDeliveryAuthority {
  readonly subscription: EventSubscription;
  /** The account the event came from, or null for an app without accounts. */
  readonly account: AccountId | null;
  /**
   * Every account bound to the invocation that emitted it, the source included. The event may
   * carry data from any of them, so the subscriber must be able to use each.
   */
  readonly accounts: readonly AccountId[];
}

/**
 * What a subscriber's access allows for one delivery. `profiles` limits it to occurrences whose
 * accounts are all selected by those saved profiles, as a connection that runs only as them.
 */
export interface EventDeliveryScope {
  readonly profiles?: readonly ProfileId[];
}

/** Host event options. Without them, subscribing fails with `EventsUnavailable`. */
export interface EventOptions {
  readonly sender: EventSender;
  /**
   * Recheck the subscriber's access before each delivery. Fail with `EventAccessRevoked` to stop
   * the subscription, or `EventNotVisible` to drop only this occurrence, such as one from an
   * account the subscriber cannot use. Any other failure leaves the delivery for a later attempt.
   * A returned scope narrows the occurrences delivered further; none allows every occurrence.
   */
  readonly authorize: (
    target: EventDeliveryAuthority,
  ) => Effect.Effect<EventDeliveryScope | void, EventAccessRevoked | EventNotVisible | Error>;
  readonly limits?: Partial<EventDeliveryLimits>;
  /**
   * Accept `http:` callback URLs. Only for development and tests against a loopback receiver;
   * the sender still decides which addresses it reaches.
   */
  readonly allowInsecureCallbacks?: boolean;
}

/** Host-only event operations. */
export interface ExecutorEvents {
  /** The events an app's active deployment declares. Nothing is evaluated. */
  readonly definitions: (input: {
    readonly app: AppId;
  }) => Effect.Effect<readonly AppEventDefinition[], StorageError>;
  /**
   * Verify the callback when needed, then save or refresh the subscription. A refresh whose event
   * or argument filters the app no longer declares stops the subscription and fails.
   */
  readonly subscribe: (
    input: SubscribeEvent,
  ) => Effect.Effect<
    EventSubscriptionGrant,
    | EventNotFound
    | EventDefinitionChanged
    | EventSubscriptionInvalid
    | EventCallbackFailed
    | EventsUnavailable
    | StorageError
    | CredentialsError
  >;
  /** Stop the subscription with this key. Repeating it succeeds. */
  readonly unsubscribe: (key: EventSubscriptionKey) => Effect.Effect<void, StorageError>;
  /** The saved subscription with this key, if any. */
  readonly find: (
    key: EventSubscriptionKey,
  ) => Effect.Effect<EventSubscription | null, StorageError>;
  /** Saved subscriptions of an app, newest first. */
  readonly list: (input: {
    readonly app: AppId;
  }) => Effect.Effect<readonly EventSubscription[], StorageError>;
  /** Stop a subscription, for example after its subscriber lost access. */
  readonly stop: (input: {
    readonly id: EventSubscriptionId;
    readonly reason: "unsubscribed" | "revoked";
  }) => Effect.Effect<void, StorageError>;
  /** Save what an invocation emitted and queue a delivery for each matching subscription. */
  readonly record: (input: {
    readonly app: AppId;
    /** Every account bound to the emitting invocation. */
    readonly accounts: readonly string[];
    readonly events: readonly EmittedEvent[];
  }) => Effect.Effect<void, StorageError | CredentialsError>;
  /**
   * Attempt up to `maxDeliveries` due deliveries, expire lapsed subscriptions and delete finished
   * work past retention. Returns whether more deliveries were due.
   */
  readonly deliver: (options: {
    readonly maxDeliveries: number;
  }) => Effect.Effect<boolean, StorageError>;
  /** When the next delivery is due, for hosts that sleep until then. */
  readonly nextWake: Effect.Effect<Date | null, StorageError>;
}
