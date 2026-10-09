/**
 * App events. An app declares the events it emits beside its account requirements, so a host
 * reads them without evaluating the app. Handlers emit occurrences; the host keeps them only
 * when the invocation that emitted them succeeds, then delivers them to its subscribers.
 */
import { Schema } from "effect";
import { AccountId, JsonObject, JsonValue } from "./schema.ts";

/** Dotted lower-case words, such as `issue.opened`. Hosts prefix them with the app's slug. */
export const EventName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u),
  Schema.isMaxLength(64),
);
export type EventName = typeof EventName.Type;

/** A filter value: subscribers match an occurrence by equal scalars. */
export const EventFilterValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);
export type EventFilterValue = typeof EventFilterValue.Type;

/** Size and count limits for events; bytes are UTF-8 bytes of the JSON text. */
export const EventLimits = Schema.Struct({
  /** An occurrence's `data`, leaving room under a 256 KiB delivery for its envelope. */
  maxDataBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  maxEventsPerInvocation: Schema.Int.check(Schema.isGreaterThan(0)),
  maxDescriptionLength: Schema.Int.check(Schema.isGreaterThan(0)),
  maxIdLength: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type EventLimits = typeof EventLimits.Type;
export const defaultEventLimits = EventLimits.make({
  maxDataBytes: 250 * 1024,
  maxEventsPerInvocation: 100,
  maxDescriptionLength: 1000,
  maxIdLength: 200,
});

/** One event as the host reads it from an app's requirements. Both schemas are JSON Schema. */
export const DeclaredEvent = Schema.Struct({
  description: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(defaultEventLimits.maxDescriptionLength),
  ),
  /** An object of scalar fields. Subscribers may name any of them to narrow an event. */
  filters: JsonObject,
  /** The shape of each occurrence's `data`. */
  payload: JsonObject,
});
export type DeclaredEvent = typeof DeclaredEvent.Type;

/** An app's declared events, by name. */
export const DeclaredEvents = Schema.Record(EventName, DeclaredEvent);
export type DeclaredEvents = typeof DeclaredEvents.Type;

/**
 * One occurrence an invocation emitted. `id` is the stable identifier subscribers deduplicate on,
 * such as the provider's delivery ID. `account` is the account the event came from, or null for
 * an app without accounts.
 */
export const EmittedEvent = Schema.Struct({
  name: EventName,
  id: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(defaultEventLimits.maxIdLength),
  ),
  /** Milliseconds since the epoch when the event happened. */
  occurredAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  data: JsonValue,
  filters: Schema.Record(Schema.String, EventFilterValue),
  account: Schema.NullOr(AccountId),
});
export type EmittedEvent = typeof EmittedEvent.Type;

/** What a successful invocation emitted, in order. */
export const EmittedEvents = Schema.Array(EmittedEvent).check(
  Schema.isMaxLength(defaultEventLimits.maxEventsPerInvocation),
);

/** Native event declaration. Filters are named scalar fields; the payload is any JSON schema. */
export interface AppEvent {
  readonly description: string;
  readonly filters: Readonly<Record<string, Schema.Decoder<unknown>>>;
  readonly payload: Schema.Decoder<unknown>;
}

/** Options for one emitted occurrence. */
export interface EmitOptions<Filters> {
  /** Values subscribers filter on. Required when the event declares filters. */
  readonly filters?: Filters;
  /**
   * A stable identifier, such as the provider's delivery or record ID, so a repeated delivery of
   * the same upstream event is not delivered twice. Defaults to a random ID.
   */
  readonly id?: string | undefined;
  /** When the event happened. Defaults to now. */
  readonly occurredAt?: Date | number | undefined;
  /**
   * The ID of the account the event came from. A webhook handler defaults to its source account,
   * and an invocation with exactly one account to that account. Name it when there are several.
   */
  readonly account?: string | undefined;
}
