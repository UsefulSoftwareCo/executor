/** App-owned credential acquisition. The host retains sessions and account ownership. */
import { Schema, type Effect } from "effect";
import { AccountInfo, AccountCheckResult } from "./provider.ts";

/** Instructions a person can follow while the app holds the sign-in session. */
export const InteractiveInstructions = Schema.Struct({
  url: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^https?:\/\//u))),
  code: Schema.optionalKey(Schema.NonEmptyString),
  paste: Schema.optionalKey(
    Schema.Struct({
      label: Schema.NonEmptyString,
      placeholder: Schema.optionalKey(Schema.String),
    }),
  ),
  expiresAt: Schema.optionalKey(Schema.Finite),
  message: Schema.optionalKey(Schema.String),
});
export type InteractiveInstructions = typeof InteractiveInstructions.Type;

/** The app retains a private session while the host presents its public instructions. */
export const InteractiveStart = Schema.Struct({
  session: Schema.NonEmptyString,
  ...InteractiveInstructions.fields,
});
export type InteractiveStart = typeof InteractiveStart.Type;

/** Progress from the app: wait, retain a plain reference, or explain why sign-in failed. */
export const InteractiveStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("waiting") }),
  Schema.Struct({
    state: Schema.Literal("connected"),
    ref: Schema.NonEmptyString,
    accountInfo: Schema.optionalKey(AccountInfo),
  }),
  Schema.Struct({ state: Schema.Literal("failed"), message: Schema.NonEmptyString }),
]);
export type InteractiveStatus = typeof InteractiveStatus.Type;

/** The method is chosen by the host from this requirement's provider. */
export interface ConnectHandlers<Context, Method extends string = string> {
  readonly start: (
    ctx: Context,
    input: { readonly method: Method },
  ) => Effect.Effect<InteractiveStart, unknown>;
  readonly status: (
    ctx: Context,
    input: { readonly method: Method; readonly session: string },
  ) => Effect.Effect<InteractiveStatus, unknown>;
  readonly submit?: (
    ctx: Context,
    input: { readonly method: Method; readonly session: string; readonly value: string },
  ) => Effect.Effect<InteractiveStatus, unknown>;
  readonly cancel?: (
    ctx: Context,
    input: { readonly method: Method; readonly session: string },
  ) => Effect.Effect<void, unknown>;
  /** Safe read with the same app accounts and caller as the other connect steps. */
  readonly check?: (
    ctx: Context,
    input: { readonly method: Method; readonly ref: string },
  ) => Effect.Effect<AccountCheckResult, unknown>;
  readonly remove?: (
    ctx: Context,
    input: { readonly method: Method; readonly ref: string },
  ) => Effect.Effect<void, unknown>;
}

const method = { method: Schema.NonEmptyString };
const session = { ...method, session: Schema.NonEmptyString };
/** Host-only command. The browser never chooses a session or credential reference. */
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
    step: Schema.Literals(["remove", "check"]),
    input: Schema.Struct({ ...method, ref: Schema.NonEmptyString }),
  }),
]);
export type ConnectCommand = typeof ConnectCommand.Type;
