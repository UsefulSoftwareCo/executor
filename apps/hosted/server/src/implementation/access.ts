import {
  AccountNotFound,
  AppNotDeployed,
  DeploymentNotFound,
  StorageError,
} from "@executor-js/sdk/core";
import {
  requireAppAccess,
  accountAccesses,
  currentResourceAuthority,
  resourceAuthorityForSelection,
  type ResourceAuthority,
} from "./resource-policy.ts";
import type {
  AppId,
  Profile,
  ProfileId,
  AccountConnectionId,
  Executor,
  OwnerId,
  SelectedAccounts,
} from "@executor-js/sdk/core";
import { Effect, Result } from "effect";
import { CurrentUserId } from "../contracts/auth.ts";
import {
  CurrentOrganization,
  OrganizationForbidden,
  organizationOwner,
} from "../contracts/organization.ts";
import type { AccountAccess } from "../contracts/resource-access.ts";

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
export const checkAccounts = (owner: OwnerId, accounts: SelectedAccounts) =>
  Effect.flatMap(currentResourceAuthority, (actor) => checkAccountsAs(actor, owner, accounts));
const selectedAccounts = (accounts: SelectedAccounts) =>
  Object.values(accounts).flatMap((selection) =>
    typeof selection === "string" ? [selection] : selection,
  );
/**
 * Check the selected accounts in selection order against their policies. A policy row exists
 * only for an account the actor's organization owns, so it also stands in for the SDK's
 * owned-account read.
 */
const permitAccounts = (
  actor: ResourceAuthority,
  owner: OwnerId,
  accounts: SelectedAccounts,
  policies: ReadonlyArray<typeof AccountAccess.Type>,
) =>
  Effect.gen(function* () {
    const byAccount = new Map(policies.map((access) => [access.account, access]));
    for (const account of selectedAccounts(accounts)) {
      const access = byAccount.get(account);
      if (access === undefined || !access.canUse) return yield* new OrganizationForbidden();
      if (owner !== organizationOwner(actor.organization))
        return yield* new AccountNotFound({ account });
    }
  });
/** Account policies are read in one statement and checked in selection order. */
export const checkAccountsAs = (
  actor: ResourceAuthority,
  owner: OwnerId,
  accounts: SelectedAccounts,
) =>
  Effect.gen(function* () {
    const selected = selectedAccounts(accounts);
    if (selected.length === 0) return;
    yield* permitAccounts(
      actor,
      owner,
      accounts,
      yield* accountAccesses([...new Set(selected)], actor),
    );
  });
type ProfileRead = Effect.Effect<
  Profile,
  Effect.Error<ReturnType<Executor["apps"]["profiles"]["get"]>>
>;
/**
 * Check both the configured app and every selected account before evaluating its code. The app
 * and profile are read first, so membership and the app's and accounts' policies take one
 * statement; failures are still reported in the order the checks run. A tool call then reads its
 * own state, after these checks.
 */
export const selectedApp = (executor: Executor, owner: OwnerId, app: AppId, profile?: ProfileId) =>
  Effect.gen(function* () {
    const current = yield* Effect.result(executor.apps.get({ owner, app }));
    const selected =
      profile === undefined
        ? undefined
        : yield* Effect.result(executor.apps.profiles.get({ app, owner, profile }));
    const { actor, access, accounts } = yield* resourceAuthorityForSelection(
      (yield* CurrentOrganization).organization,
      yield* CurrentUserId,
      app,
      selected === undefined || Result.isFailure(selected)
        ? []
        : [...new Set(selectedAccounts(selected.success.accounts))],
    );
    if (!access.canUse) return yield* new OrganizationForbidden();
    const found = yield* Effect.fromResult(current);
    if (selected === undefined) return found;
    const checked = yield* ownedBy(actor, Effect.fromResult(selected));
    yield* permitAccounts(actor, owner, checked.accounts, yield* accounts);
    return found;
  });
/** New tool discovery and calls use the active build; retained execution is reserved for saved invocations. */
export const selectedActiveDeployment = (
  executor: Executor,
  owner: OwnerId,
  input: Parameters<Executor["tools"]["list"]>[0],
) =>
  Effect.gen(function* () {
    const app = yield* selectedApp(executor, owner, input.app, input.profile);
    if (input.deployment !== undefined && input.deployment !== app.activeDeployment)
      return yield* new DeploymentNotFound({ app: app.id, deployment: input.deployment });
    if (app.activeDeployment === null) return yield* new AppNotDeployed({ app: app.id });
    // Pin the authorized version so a concurrent promotion cannot silently change the call.
    return app.activeDeployment;
  });

/** Setup identity remains private even when every selected account is shared. Allows own cleanup after revocation. */
export const ownProfile = (executor: Executor, owner: OwnerId, app: AppId, profile: ProfileId) =>
  Effect.flatMap(currentResourceAuthority, (actor) =>
    ownProfileAs(actor, executor, owner, app, profile),
  );
export const ownProfileAs = (
  actor: ResourceAuthority,
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  profile: ProfileId,
) => ownedBy(actor, executor.apps.profiles.get({ app, owner, profile }));
/** The setup subject is the actor; another user's profile is forbidden, not missing. */
const ownedBy = (actor: ResourceAuthority, read: ProfileRead) =>
  Effect.gen(function* () {
    const selected = yield* read.pipe(
      Effect.catchTags({
        ProfileNotFound: () => new OrganizationForbidden(),
        ProfileConflict: () => new StorageError(),
        AccountSelectionInvalid: () => new StorageError(),
      }),
    );
    if (selected.subject !== actor.user) return yield* new OrganizationForbidden();
    return selected;
  });
/** The caller's own profile and every account it selects, reading the caller's membership once. */
export const selectedProfile = (
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  profile: ProfileId,
) =>
  Effect.gen(function* () {
    const actor = yield* currentResourceAuthority;
    const selected = yield* ownProfileAs(actor, executor, owner, app, profile);
    yield* checkAccountsAs(actor, owner, selected.accounts);
    return selected;
  });
/** App-only resources require app management; profile resources require their subject. */
export const executionManagerOwner = (executor: Executor, app: AppId, profile?: ProfileId) =>
  Effect.gen(function* () {
    const owner = yield* currentOwner;
    if (profile === undefined) yield* requireAppAccess(app, "manage");
    else yield* ownProfile(executor, owner, app, profile);
    return owner;
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

/** Pending approvals retain their original accounts even if current app bindings later change. */
export const checkInvocationAccounts = (
  executor: Executor,
  owner: OwnerId,
  invocation: import("@executor-js/sdk/core").ToolInvocation,
) =>
  Effect.gen(function* () {
    if (invocation.profile !== undefined)
      yield* ownProfile(executor, owner, invocation.app, invocation.profile);
    yield* checkAccounts(
      owner,
      Object.fromEntries(
        Object.entries(invocation.accounts).map(([slot, selected]) => [
          slot,
          "id" in selected ? selected.id : selected.map((account) => account.id),
        ]),
      ),
    );
  });
