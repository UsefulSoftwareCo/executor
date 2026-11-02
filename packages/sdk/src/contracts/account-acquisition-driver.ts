import { Context, Schema, type Effect, type Redacted } from "effect";
import type { AccountCheckResult, InteractiveStart, InteractiveStatus } from "apps/contracts";
import { AccountId, OwnerId, ProviderId, type StorageError } from "./shared.ts";
import type { AccountNotFound } from "./account.ts";
import { UserFacingError } from "@executor-js/utils/user-facing-error";

export const AccountAcquisitionUnavailable = UserFacingError.define({
  tag: "AccountAcquisitionUnavailable",
  status: 503,
  fields: { reason: Schema.Literals(["registration", "binding", "changed", "unsupported"]) },
  title: "Account connection unavailable",
  description: "The host cannot resolve this account's connection handler.",
  recovery: {
    action: "Reload the account and retry after the host configuration is restored.",
    instructions:
      "Keep the saved account and its reference. Restore the retained driver revision or resolve a changed binding before retrying. Do not reconnect or delete a credential to hide this failure.",
  },
});
export type AccountAcquisitionUnavailable = typeof AccountAcquisitionUnavailable.Type;

export const AccountAcquisitionRemoval = Schema.Struct({
  operation: Schema.NonEmptyString,
  removed: Schema.Boolean,
  lease: Schema.optionalKey(Schema.NonEmptyString),
  leaseUntil: Schema.optionalKey(Schema.Finite),
});
export type AccountAcquisitionRemoval = typeof AccountAcquisitionRemoval.Type;

export const AccountAcquisitionBinding = Schema.Struct({
  account: AccountId,
  owner: OwnerId,
  provider: ProviderId,
  method: Schema.NonEmptyString,
  driver: Schema.NonEmptyString,
  driverRevision: Schema.NonEmptyString,
  generation: Schema.Int,
  revision: Schema.NonEmptyString,
  removal: Schema.NullOr(AccountAcquisitionRemoval),
});
export type AccountAcquisitionBinding = typeof AccountAcquisitionBinding.Type;

/** Product code registers drivers; app declarations cannot choose their implementation. */
export interface AccountAcquisitionContext {
  readonly owner: OwnerId;
  readonly provider: ProviderId;
  readonly method: string;
  readonly operation: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly fetch: typeof globalThis.fetch;
}

/** The host decrypts the reference only after resolving the saved account and current binding. */
export interface AccountAcquisitionAccountContext extends AccountAcquisitionContext {
  readonly binding: AccountAcquisitionBinding;
  readonly reference: Redacted.Redacted<string>;
}

export interface AccountAcquisitionDriver<
  Context extends AccountAcquisitionAccountContext = AccountAcquisitionAccountContext,
> {
  readonly check?: (context: Context) => Effect.Effect<AccountCheckResult | void, unknown>;
  readonly id: string;
  readonly revision: string;
  readonly start: (
    context: AccountAcquisitionContext,
    reconnect?: Context,
  ) => Effect.Effect<InteractiveStart, unknown>;
  readonly status: (
    context: AccountAcquisitionContext,
    input: { readonly session: string },
  ) => Effect.Effect<InteractiveStatus, unknown>;
  readonly submit?: (
    context: AccountAcquisitionContext,
    input: { readonly session: string; readonly value: string },
  ) => Effect.Effect<InteractiveStatus, unknown>;
  /** Abandon this attempt and its newly created credential only. Never revoke a saved/reused login. */
  readonly cancel: (
    context: AccountAcquisitionContext,
    input: { readonly session: string },
  ) => Effect.Effect<void, unknown>;
  /** Idempotent for the host operation ID, including a retry after an uncertain response. */
  readonly remove: (context: Context) => Effect.Effect<void, unknown>;
}

export interface AccountAcquisitionRegistration {
  readonly provider: ProviderId;
  readonly method: string;
  /** Retain earlier revisions for pending attempts and saved bindings, without offering new connects. */
  readonly current: boolean;
  readonly driver: AccountAcquisitionDriver;
  readonly fetch: typeof globalThis.fetch;
}

export interface AccountAcquisitionOptions {
  readonly registrations: readonly AccountAcquisitionRegistration[];
}

/** Complete product launchers can supply registrations without replacing SDK services. */
export const AccountAcquisitionConfiguration = Context.Reference<AccountAcquisitionOptions>(
  "executor/AccountAcquisitionConfiguration",
  { defaultValue: () => ({ registrations: [] }) },
);

export interface AccountAcquisitionSource {
  readonly binding: AccountAcquisitionBinding;
  readonly source: { readonly kind: "driver"; readonly id: string; readonly version: string };
  readonly current: Effect.Effect<
    AccountAcquisitionBinding,
    StorageError | AccountNotFound | AccountAcquisitionUnavailable
  >;
  readonly check?: () => ReturnType<NonNullable<AccountAcquisitionDriver["check"]>>;
}

/** Products authorize inspection/use/refresh before resolving this distinct driver source. */
export const AccountAcquisitionHost = Symbol("executor.AccountAcquisitionHost");
export interface AccountAcquisitionHost {
  readonly binding: (input: {
    readonly account: AccountId;
    readonly owner?: OwnerId;
  }) => Effect.Effect<AccountAcquisitionBinding | undefined, StorageError>;
  readonly source: (input: {
    readonly account: AccountId;
    readonly owner?: OwnerId;
  }) => Effect.Effect<
    AccountAcquisitionSource | undefined,
    StorageError | AccountNotFound | AccountAcquisitionUnavailable
  >;
}
