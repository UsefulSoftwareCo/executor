import { requireAppAccess, requireAccountAccess } from "./resource-policy.ts";
import type {
  AppId,
  AccountConnectionId,
  Executor,
  OwnerId,
  SelectedAccounts,
} from "@executor-js/sdk/core";
import { Effect } from "effect";
import { CurrentOrganization, OrganizationForbidden } from "../contracts/organization.ts";

/** Membership was checked by middleware; administrative actions require the current role. */
export const requireOrganizationAdmin = Effect.gen(function* () {
  const organization = yield* CurrentOrganization;
  if (organization.role === "member") return yield* new OrganizationForbidden();
  return organization;
});
/** Only an owner may remove the organization itself. */
export const requireOrganizationOwner = Effect.gen(function* () {
  const organization = yield* CurrentOrganization;
  if (organization.role !== "owner") return yield* new OrganizationForbidden();
  return organization;
});
/** Server-derived owners are the only owners used by hosted HTTP handlers. */
export const currentOwner = Effect.map(CurrentOrganization, (organization) => organization.owner);
/** Resolve administrative authority before opening the SDK or performing work. */
export const adminOwner = Effect.map(
  requireOrganizationAdmin,
  (organization) => organization.owner,
);

/** Account use requires its independent sharing policy as well as the SDK tenant check. */
export const checkAccounts = (executor: Executor, owner: OwnerId, accounts: SelectedAccounts) =>
  Effect.gen(function* () {
    for (const selection of Object.values(accounts)) {
      for (const account of typeof selection === "string" ? [selection] : selection) {
        yield* requireAccountAccess(account, "use");
        yield* executor.accounts.get({ owner, account });
      }
    }
  });
/** Check both the configured app and every selected account before evaluating its code. */
export const selectedApp = (executor: Executor, owner: OwnerId, app: AppId) =>
  Effect.gen(function* () {
    yield* requireAppAccess(app, "use");
    const current = yield* executor.apps.get({ owner, app });
    yield* checkAccounts(executor, owner, current.accounts);
    return current;
  });
/** A connection must still belong to this organization, along with its optional target app. */
export const ownedConnection = (
  executor: Executor,
  owner: OwnerId,
  connection: AccountConnectionId,
) =>
  Effect.gen(function* () {
    const current = yield* executor.accountConnections.get({ owner, connection });
    if (current.target !== null) yield* executor.apps.get({ owner, app: current.target.app });
    return current;
  });

/** App creators and admins manage settings; this does not authorize account-backed execution. */
export const appManagerOwner = (app: AppId) =>
  requireAppAccess(app, "manage").pipe(Effect.andThen(currentOwner));
/** Metadata reads include separate management access, without selecting credentials. */
export const appReaderOwner = (app: AppId) =>
  requireAppAccess(app, "read").pipe(Effect.andThen(currentOwner));
/** Personal ownership and shared-account management are resolved by account policy. */
export const accountManagerOwner = (account: import("@executor-js/sdk/core").AccountId) =>
  requireAccountAccess(account, "manage").pipe(Effect.andThen(currentOwner));

/** Pending approvals retain their original accounts even if current app bindings later change. */
export const checkInvocationAccounts = (
  executor: Executor,
  owner: OwnerId,
  invocation: import("@executor-js/sdk/core").ToolInvocation,
) =>
  checkAccounts(
    executor,
    owner,
    Object.fromEntries(
      Object.entries(invocation.accounts).map(([slot, selected]) => [
        slot,
        "id" in selected ? selected.id : selected.map((account) => account.id),
      ]),
    ),
  );
