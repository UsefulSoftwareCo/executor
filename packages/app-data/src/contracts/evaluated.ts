import { Schema } from "effect";

const Key = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Time = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Body = Schema.Uint8Array;

export const evaluatedLimits = {
  partBytes: 1_000_000,
  entryBytes: 8_000_000,
  totalBytes: 64_000_000,
} as const;

export const EvaluatedCommand = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("read"), key: Key }),
  Schema.Struct({ operation: Schema.Literal("changed") }),
  Schema.Struct({
    operation: Schema.Literal("write"),
    key: Key,
    at: Time,
    until: Time,
    body: Body,
  }),
]);
export type EvaluatedCommand = typeof EvaluatedCommand.Type;

export const EvaluatedSupervisor = Schema.Struct({
  woke: Schema.Boolean,
  instanceMs: Time,
  isolateMs: Time,
});
export type EvaluatedSupervisor = typeof EvaluatedSupervisor.Type;

export const EvaluatedEntry = Schema.Union([
  Schema.Null,
  Schema.Struct({ at: Time, body: Body, supervisor: Schema.optionalKey(EvaluatedSupervisor) }),
  Schema.Struct({ missing: Schema.Literal(true), supervisor: EvaluatedSupervisor }),
]);
export type EvaluatedEntry = typeof EvaluatedEntry.Type;

export const EvaluatedWritten = Schema.Struct({
  kept: Schema.Boolean,
  supervisor: EvaluatedSupervisor,
});
export type EvaluatedWritten = typeof EvaluatedWritten.Type;

export const EvaluatedChanged = Schema.Struct({
  changed: Schema.NullOr(Time),
  supervisor: EvaluatedSupervisor,
});
export type EvaluatedChanged = typeof EvaluatedChanged.Type;

export const EvaluatedCommandJson = Schema.fromJsonString(Schema.toCodecJson(EvaluatedCommand));
export const EvaluatedReplyJson = Schema.fromJsonString(
  Schema.toCodecJson(Schema.Union([EvaluatedEntry, EvaluatedWritten, EvaluatedChanged])),
);
