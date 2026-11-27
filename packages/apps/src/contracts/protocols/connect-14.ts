/** Connect commands supported by protocol 14, before app-owned account checks. */
import { Schema } from "effect";

const method = { method: Schema.NonEmptyString };
const session = { ...method, session: Schema.NonEmptyString };

export const ConnectCommand = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("connect"),
    slot: Schema.NonEmptyString,
    step: Schema.Literal("start"),
    input: Schema.Struct(method),
  }),
  Schema.Struct({
    operation: Schema.Literal("connect"),
    slot: Schema.NonEmptyString,
    step: Schema.Literals(["status", "cancel"]),
    input: Schema.Struct(session),
  }),
  Schema.Struct({
    operation: Schema.Literal("connect"),
    slot: Schema.NonEmptyString,
    step: Schema.Literal("submit"),
    input: Schema.Struct({ ...session, value: Schema.String }),
  }),
  Schema.Struct({
    operation: Schema.Literal("connect"),
    slot: Schema.NonEmptyString,
    step: Schema.Literal("remove"),
    input: Schema.Struct({ ...method, ref: Schema.NonEmptyString }),
  }),
]);

export type ConnectCommand = typeof ConnectCommand.Type;
