/**
 * Host protocol 11: protocol 10 plus app events.
 *
 * Requirements carry the events an app declares (`events`), so a host lists them without
 * evaluating the app. A successful reply carries the occurrences its invocation emitted
 * (`events`). Older bundles never send either, so their requirements declare no events and their
 * replies emit none. A cache failure may name the limit its request exceeded (`limit`); older hosts
 * never send it. Every other message is protocol 10's, re-exported unchanged.
 *
 * Once released this protocol is frozen like the earlier ones: `bun run check` compares `protocol11`
 * with `packages/apps/protocols/11.json`. The module imports only `effect` and earlier protocol
 * modules, so no change elsewhere can alter it. Define the next protocol instead of editing this
 * file. See notes/apps-publishing.md.
 */
import { Schema } from "effect";
import { AccountId, JsonObject, JsonValue } from "./1.ts";
import { DeclaredRequirements as PreviousRequirements, HostError, protocol10 } from "./10.ts";

export * from "./10.ts";

/** Dotted lower-case words, such as `issue.opened`. Hosts prefix them with the app's slug. */
export const EventName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u),
  Schema.isMaxLength(64),
);

/** A filter value: subscribers match an occurrence by equal scalars. */
export const EventFilterValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);

/** One event as the host reads it from an app's requirements. Both schemas are JSON Schema. */
export const DeclaredEvent = Schema.Struct({
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  filters: JsonObject,
  payload: JsonObject,
});

/** An app's declared events, by name. */
export const DeclaredEvents = Schema.Record(EventName, DeclaredEvent);

/** One occurrence an invocation emitted. */
export const EmittedEvent = Schema.Struct({
  name: EventName,
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  occurredAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  data: JsonValue,
  filters: Schema.Record(Schema.String, EventFilterValue),
  account: Schema.NullOr(AccountId),
});

/** What a successful invocation emitted, in order. */
export const EmittedEvents = Schema.Array(EmittedEvent).check(Schema.isMaxLength(100));

/** Protocol 10's requirements, plus the app's declared events. */
export const DeclaredRequirements = Schema.Struct({
  ...PreviousRequirements.fields,
  events: Schema.optionalKey(DeclaredEvents),
});
export type DeclaredRequirements = typeof DeclaredRequirements.Type;

/** Portable response envelope. A success carries the events its invocation emitted, if any. */
export const HostResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    value: JsonValue,
    toolError: Schema.optionalKey(Schema.Literal(true)),
    events: Schema.optionalKey(EmittedEvents),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: HostError }),
]);
export type HostResponse = typeof HostResponse.Type;

/** Expected cache failures, naming which of the cache's limits a request exceeded, when one did. */
export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
  reason: Schema.Literals(["unavailable", "storage", "invalid", "capacity", "timeout"]),
  limit: Schema.optionalKey(
    Schema.Literals([
      "keyBytes",
      "entryBytes",
      "batchBytes",
      "batchEntries",
      "totalBytes",
      "totalEntries",
    ]),
  ),
}) {}

/** A cache command's result. */
export const CacheReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({ ok: Schema.Literal(false), error: CacheError }),
]);

/** Every message of protocol 11, in the order its snapshot records them. */
export const protocol11 = {
  version: 11,
  schemas: {
    ...protocol10.schemas,
    requirements: DeclaredRequirements,
    response: HostResponse,
    cacheReply: CacheReply,
  },
} as const;
