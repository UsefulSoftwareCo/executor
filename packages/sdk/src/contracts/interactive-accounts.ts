/** Host-only interactive connection state and operations. No session enters a public response. */
import { Context, Schema, type Effect } from "effect";
import { InteractiveInstructions, AccountInfo } from "apps/contracts";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { Account } from "./account.ts";
import type { AppAccounts } from "./apps.ts";
import {
  AppId,
  VersionId,
  type AccountConnectionId,
  type AccountId,
  type OwnerId,
  type StorageError,
} from "./shared.ts";

export const InteractiveConnectionFailed = UserFacingError.define({
  tag: "InteractiveConnectionFailed",
  status: 422,
  fields: { reason: Schema.Literal("step") },
  title: "Sign-in could not finish",
  description: "The app could not complete this sign-in step.",
  recovery: {
    action: "Cancel this sign-in and start a new connection.",
    instructions:
      "Inspect the app's interactive connection handlers and backend. Keep its session private. Start a fresh connection after resolving the failure.",
  },
});
export type InteractiveConnectionFailed = typeof InteractiveConnectionFailed.Type;

/** Persisted in the existing connection state JSON while a sign-in is pending. */
export const InteractiveSession = Schema.Struct({
  method: Schema.NonEmptyString,
  version: VersionId,
  session: Schema.optionalKey(Schema.NonEmptyString),
  instructions: Schema.optionalKey(InteractiveInstructions),
  failed: Schema.optionalKey(Schema.NonEmptyString),
  running: Schema.optionalKey(Schema.String),
  leaseExpiresAt: Schema.optionalKey(Schema.Finite),
});
export type InteractiveSession = typeof InteractiveSession.Type;

/** Completed connections retain acquisition provenance, without their former session. */
export const InteractiveBinding = Schema.Struct({
  app: AppId,
  slot: Schema.NonEmptyString,
  method: Schema.NonEmptyString,
  version: VersionId,
  ref: Schema.NonEmptyString,
  accountInfo: Schema.optionalKey(AccountInfo),
  acquiredAt: Schema.Finite,
  retirement: Schema.optionalKey(
    Schema.Struct({
      token: Schema.optionalKey(Schema.String),
      expiresAt: Schema.optionalKey(Schema.Finite),
      removed: Schema.Boolean,
    }),
  ),
});
export type InteractiveBinding = typeof InteractiveBinding.Type;

/** The same result shape status and paste submission expose over HTTP. */
export const InteractiveConnectionStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("waiting") }),
  Schema.Struct({ state: Schema.Literal("connected"), account: Account }),
  Schema.Struct({ state: Schema.Literal("failed"), message: Schema.String }),
]);
export type InteractiveConnectionStatus = typeof InteractiveConnectionStatus.Type;

type Input = {
  readonly owner: OwnerId;
  readonly connection: AccountConnectionId;
  readonly accounts: AppAccounts;
};
type Failure =
  | StorageError
  | InteractiveConnectionFailed
  | import("./interactive-errors.ts").InteractiveRetirementBusy
  | import("./interactive-errors.ts").InteractiveRetirementFailed;
/** Accounts whose local deletion this retirement owns, including its rolled-back validation. */
export const InteractiveRemovalDone = Context.Reference<ReadonlySet<AccountId>>(
  "executor/InteractiveRemovalDone",
  { defaultValue: () => new Set() },
);
export const InteractiveHost = Symbol("executor.InteractiveHost");
/** Products authorize the pending connection and supply its caller's current linked accounts. */
export interface InteractiveHost {
  /** Validate locally, commit a lease, invoke without SQL, then recheck and commit. */
  readonly retire: <A, E, R>(
    input: { readonly accounts: readonly AccountId[]; readonly owner: OwnerId },
    action: Effect.Effect<A, E, R>,
  ) => Effect.Effect<
    A,
    | E
    | StorageError
    | import("./interactive-errors.ts").InteractiveRetirementBusy
    | import("./interactive-errors.ts").InteractiveRetirementFailed,
    R
  >;
  readonly acquired: (input: {
    readonly app?: import("./shared.ts").AppId;
    readonly owner: OwnerId;
  }) => Effect.Effect<readonly AccountId[], StorageError>;
  readonly start: (
    input: Input & { readonly method: string },
  ) => Effect.Effect<InteractiveInstructions, Failure>;
  readonly status: (input: Input) => Effect.Effect<InteractiveConnectionStatus, Failure>;
  readonly submit: (
    input: Input & { readonly value: string },
  ) => Effect.Effect<InteractiveConnectionStatus, Failure>;
  readonly cancel: (input: Input) => Effect.Effect<void, Failure>;
  readonly binding: (input: {
    readonly owner: OwnerId;
    readonly account: AccountId;
  }) => Effect.Effect<InteractiveBinding | undefined, StorageError>;
  /** Invoke remove before the product deletes this account. Missing apps are logged and skipped. */
  readonly remove: (input: {
    readonly owner: OwnerId;
    readonly account: AccountId;
    readonly accounts?: AppAccounts;
  }) => Effect.Effect<void, Failure>;
}
