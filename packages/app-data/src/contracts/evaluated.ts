/** Protocol of the store of evaluated results an app's supervisor keeps beside its app cache. */
import { Schema } from "effect";

const Key = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Time = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Body = Schema.declare((value): value is Uint8Array => value instanceof Uint8Array);

/** Bounds of one app's store. Bodies are compressed by the caller before they are written. */
export const evaluatedLimits = {
  /** SQLite on Durable Objects stores at most 2 MB in one value. */
  partBytes: 1_000_000,
  entryBytes: 8_000_000,
  totalBytes: 64_000_000,
} as const;

/**
 * `at` is when the read that produced the result began; `until` is when the store may drop it.
 * A write whose evaluation began no later than the app's last cache invalidation is refused.
 */
export const EvaluatedCommand = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("read"), key: Key }),
  Schema.Struct({
    operation: Schema.Literal("write"),
    key: Key,
    at: Time,
    until: Time,
    body: Body,
  }),
]);
export type EvaluatedCommand = typeof EvaluatedCommand.Type;

/**
 * How the supervisor that answered was running, for the caller's span: whether the command was
 * the first its instance received, and how long its instance and its isolate had been running,
 * on the supervisor's clock. A command that wakes the supervisor reads `woke` with both near 0.
 */
export const EvaluatedSupervisor = Schema.Struct({
  woke: Schema.Boolean,
  instanceMs: Time,
  isolateMs: Time,
});
export type EvaluatedSupervisor = typeof EvaluatedSupervisor.Type;

/**
 * A read's reply: the kept body, or `missing` when there is none evaluated since the last
 * invalidation. Supervisors deployed before `supervisor` was reported answer a miss with `null`;
 * a caller from before then decodes `missing` as a failed read, which it also treats as a miss.
 */
export const EvaluatedEntry = Schema.Union([
  Schema.Null,
  Schema.Struct({ at: Time, body: Body, supervisor: Schema.optionalKey(EvaluatedSupervisor) }),
  Schema.Struct({ missing: Schema.Literal(true), supervisor: EvaluatedSupervisor }),
]);
export type EvaluatedEntry = typeof EvaluatedEntry.Type;

/** A write's reply. Callers from before `supervisor` was reported ignore it. */
export const EvaluatedWritten = Schema.Struct({
  kept: Schema.Boolean,
  supervisor: EvaluatedSupervisor,
});
export type EvaluatedWritten = typeof EvaluatedWritten.Type;
