/** Compile-only checks: an account use case runs only on a target declared for its action. */
import { AccountId, type OwnerId } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { HttpApiEndpoint } from "effect/http-api";
import {
  AccountTargets,
  requireAccount,
  type AccountAction,
  type AccountProof,
  type AccountTarget,
} from "../../contracts/account-grants.ts";
import type { AccountAccess } from "../../contracts/resource-access.ts";
import { checkAccount, disconnectAccount, getAccount, updateAccount } from "../accounts.ts";
import { AccountGrants } from "./account-access.ts";

declare const owner: OwnerId;
declare const account: AccountId;
declare const access: typeof AccountAccess.Type;
declare const inspect: AccountProof<"inspect">;

/** Accepts an effect only when no account target remains among its requirements. */
const targeted = <X, E, R>(
  effect: Effect.Effect<X, E, R>,
  ..._: [Extract<R, AccountTarget<AccountAction>>] extends [never]
    ? []
    : [missing: Extract<R, AccountTarget<AccountAction>>]
) => effect;

export const allowed = [
  targeted(getAccount.pipe(Effect.provideService(AccountTargets.inspect, { account }))),
  targeted(checkAccount.pipe(Effect.provideService(AccountTargets.use, { account }))),
  // App connections check a reconnect's account here.
  targeted(
    AccountGrants.reconnect.pipe(Effect.provideService(AccountTargets.reconnect, { account })),
  ),
  targeted(disconnectAccount.pipe(Effect.provideService(AccountTargets.delete, { account }))),
  targeted(
    updateAccount({ label: "Renamed" }).pipe(
      Effect.provideService(AccountTargets.rename, { account }),
    ),
  ),
];

export const rejected = [
  // @ts-expect-error A use case on an endpoint without account middleware.
  targeted(disconnectAccount),
  // @ts-expect-error Inspecting an account does not permit using its credentials.
  targeted(checkAccount.pipe(Effect.provideService(AccountTargets.inspect, { account }))),
  // @ts-expect-error Renaming an account does not permit deleting it.
  targeted(disconnectAccount.pipe(Effect.provideService(AccountTargets.rename, { account }))),
  // @ts-expect-error Reconnecting replaces credentials; it does not permit renaming.
  targeted(updateAccount({}).pipe(Effect.provideService(AccountTargets.reconnect, { account }))),
  // @ts-expect-error Using credentials does not permit replacing them.
  targeted(AccountGrants.reconnect.pipe(Effect.provideService(AccountTargets.use, { account }))),
  // @ts-expect-error Each target serves only its own action, even where the policy is wider.
  targeted(getAccount.pipe(Effect.provideService(AccountTargets.delete, { account }))),
];

// Proofs come only from a grant: they cannot be built or exchanged between actions.
// @ts-expect-error A hand-built value carries no evidence.
export const built: AccountProof<"delete"> = { owner, account, access };
// @ts-expect-error An inspect proof is not a delete proof.
export const exchanged: AccountProof<"delete"> = inspect;

// requireAccount attaches account middleware only where the route decodes an `account` AccountId.
export const endpoints = [
  HttpApiEndpoint.delete("a", "/x/:account", { params: { account: AccountId } }).pipe(
    requireAccount.delete,
  ),
  HttpApiEndpoint.delete("b", "/x/:accountId", { params: { accountId: AccountId } }).pipe(
    // @ts-expect-error The middleware reads `account`, not `accountId`.
    requireAccount.delete,
  ),
  HttpApiEndpoint.delete("c", "/x/:account", { params: { account: Schema.String } }).pipe(
    // @ts-expect-error The parameter must decode as an AccountId.
    requireAccount.delete,
  ),
  HttpApiEndpoint.post("d", "/x", { payload: Schema.Struct({ account: AccountId }) }).pipe(
    // @ts-expect-error An account in the body is not a route target.
    requireAccount.delete,
  ),
];
