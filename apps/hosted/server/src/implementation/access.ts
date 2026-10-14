import {
  AccountNotFound,
  AppNotDeployed,
  DeploymentNotFound,
  invocationAccounts,
  sameAccounts,
} from "@executor-js/sdk/core";
import {
  requireAppAccess,
  requireCurrentAppAccess,
  accountAccesses,
  currentResourceAuthority,
  policyDatabase,
  resourceAuthorityForApp,
  resourceAuthorityForLinks,
  type ResourceAuthority,
} from "./resource-policy.ts";
import type {
  App,
  AppAccounts,
  AppId,
  AccountConnectionId,
  DeploymentId,
  Executor,
  OwnerId,
  SelectedAccounts,
} from "@executor-js/sdk/core";
import type { ToolIdentity } from "@executor-js/authorization";
import type { ToolAuthorization } from "./authorization.ts";
import { Context, Effect, type Exit, Result } from "effect";
import { HttpServerRequest } from "effect/http";
import { CurrentUserId, Forbidden } from "../contracts/auth.ts";
import {
  appAccountReads,
  appLinkedAccounts,
  callerAccounts,
  versionAccounts,
} from "./app-accounts.ts";
import {
  CurrentOrganization,
  OrganizationForbidden,
  type OrganizationId,
  organizationOwner,
} from "../contracts/organization.ts";

/** A person's own decisions come from their signed-in browser, never from an API credential. */
export const browserOnly = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers.authorization !== undefined) return yield* new Forbidden();
});
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
/**
 * Account policies are read in one statement and checked in selection order. A policy row
 * exists only for an account the actor's organization owns, so it also stands in for the
 * SDK's owned-account read.
 */
export const checkAccountsAs = (
  actor: ResourceAuthority,
  owner: OwnerId,
  accounts: SelectedAccounts,
) =>
  Effect.gen(function* () {
    const selected = Object.values(accounts).flatMap((selection) =>
      typeof selection === "string" ? [selection] : selection,
    );
    if (selected.length === 0) return;
    const policies = new Map(
      (yield* accountAccesses([...new Set(selected)], actor)).map((access) => [
        access.account,
        access,
      ]),
    );
    for (const account of selected) {
      const access = policies.get(account);
      if (access === undefined || !access.canUse) return yield* new OrganizationForbidden();
      if (owner !== organizationOwner(actor.organization))
        return yield* new AccountNotFound({ account });
    }
  });
/** The configured app, after checking the caller may use it. */
export const usableApp = (executor: Executor, owner: OwnerId, app: AppId) =>
  Effect.gen(function* () {
    yield* requireCurrentAppAccess(app, "use");
    return yield* executor.apps.get({ owner, app });
  });
/**
 * The app read a selection check made ahead, and what it was read for. The check uses it only for
 * the app's requirements, the deployment pin and the order of its failures; a tool call reads its
 * own state after the check.
 */
export interface SelectionReads {
  readonly owner: OwnerId;
  readonly app: AppId;
  readonly current: Result.Result<App, Effect.Error<ReturnType<Executor["apps"]["get"]>>>;
}
/**
 * Whether a read made ahead answered: it stands in for the read it was made for unless it failed
 * for storage. Reads made at once share a connection, so one dropped after the recheck's reply
 * fails the rest; read in order, the same read could reach a fresh connection.
 */
const answered = <A, E extends { readonly _tag: string }>(read: Result.Result<A, E>) =>
  Result.isSuccess(read) || read.failure._tag !== "StorageError";
/**
 * The access fold with the caller's links that an MCP tool call made in one batch with its recheck
 * and app read, and what it was made for. {@link usableAppWithLinks} uses its result, where it
 * would run the fold, only beside a read made ahead and only for the same organization, user and
 * app; otherwise it runs the fold.
 */
export const FoldReadAhead = Context.Reference<
  | {
      readonly organization: OrganizationId;
      readonly user: string;
      readonly app: AppId;
      readonly result: Exit.Exit<
        Effect.Success<ReturnType<typeof resourceAuthorityForLinks>>,
        Effect.Error<ReturnType<typeof resourceAuthorityForLinks>>
      >;
    }
  | undefined
>("hosted/FoldReadAhead", { defaultValue: () => undefined });
/**
 * The app read an MCP tool call made beside its authentication recheck, for the call it is about
 * to make. Unset everywhere else.
 */
export const SelectionReadAhead = Context.Reference<SelectionReads | undefined>(
  "hosted/SelectionReadAhead",
  { defaultValue: () => undefined },
);
/**
 * The app read of {@link selectedApp}, made ahead. Only a host whose SQL client sends concurrent
 * statements together should ask for it this way (see `ConcurrentStatements`); elsewhere it would
 * wait for, or open, another connection.
 */
export const readSelection = (executor: Executor, owner: OwnerId, app: AppId) =>
  Effect.map(Effect.result(executor.apps.get({ owner, app })), (current): SelectionReads => ({
    owner,
    app,
    current,
  }));
/**
 * {@link usableApp} with the caller's links to the app and the app links. The app is read
 * first, so membership, the app's policy and, when its active deployment declares accounts, the
 * caller's links and the app links take one statement; an app the caller may not use is still refused before a missing one. An operation
 * then reads its own state, after these checks. `read`
 * is the app read the caller made earlier, used only when it was made for this owner and app and
 * answered; with it, an access fold made in the same batch ({@link FoldReadAhead}) stands in for
 * the fold when it was made for this organization, user and app.
 */
const usableAppWithLinks = (
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  read?: SelectionReads,
) =>
  Effect.gen(function* () {
    const ahead =
      read !== undefined && read.owner === owner && read.app === app && answered(read.current)
        ? read.current
        : undefined;
    const current = ahead ?? (yield* Effect.result(executor.apps.get({ owner, app })));
    const organization = (yield* CurrentOrganization).organization;
    const user = yield* CurrentUserId;
    const fold = read === undefined ? undefined : yield* FoldReadAhead;
    const { access, accounts } =
      fold !== undefined &&
      fold.organization === organization &&
      fold.user === user &&
      fold.app === app
        ? yield* fold.result
        : Result.isSuccess(current) &&
            Object.keys(current.success.requirements.accounts).length === 0
          ? // The active deployment needs no account, so the statement reads no links or
            // app links. A retained deployment that declares accounts reads them when it resolves
            // its requirements.
            yield* resourceAuthorityForApp(organization, user, app).pipe(
              Effect.flatMap(({ actor, access }) =>
                Effect.map(policyDatabase, (sql) => ({
                  access,
                  accounts: appAccountReads(sql, { subject: actor.user, app }),
                })),
              ),
            )
          : yield* resourceAuthorityForLinks(organization, user, app);
    if (!access.canUse) return yield* new OrganizationForbidden();
    return { app: yield* Effect.fromResult(current), linked: accounts };
  });
/**
 * Check the configured app and resolve the accounts the caller's operation runs with, before
 * evaluating its code. See {@link callerAccounts}.
 */
export const selectedApp = (
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  read?: SelectionReads,
) =>
  Effect.gen(function* () {
    const { app: current, linked } = yield* usableAppWithLinks(executor, owner, app, read);
    return { app: current, accounts: yield* callerAccounts(current, linked) };
  });
/**
 * Check the configured app and resolve the caller's accounts for one of its deployments: a
 * retained one in its code lineage when pinned, else the active one. Reads of an earlier
 * deployment, such as its skills, resolve its own requirements.
 */
export const selectedVersion = (
  executor: Executor,
  owner: OwnerId,
  input: { readonly app: AppId; readonly deployment?: DeploymentId | undefined },
) =>
  Effect.gen(function* () {
    const { app: current, linked } = yield* usableAppWithLinks(executor, owner, input.app);
    if (input.deployment === undefined || input.deployment === current.activeDeployment)
      return yield* callerAccounts(current, linked);
    const retained = yield* executor.apps.deployment({
      owner,
      app: input.app,
      deployment: input.deployment,
    });
    return yield* versionAccounts(
      { app: current.id, deployment: retained.id, requirements: retained.requirements },
      linked,
    );
  });
/** New tool discovery and calls use the active build; retained execution is reserved for saved invocations. */
export const selectedActiveDeployment = (
  executor: Executor,
  owner: OwnerId,
  input: { readonly app: AppId; readonly deployment?: DeploymentId | undefined },
) =>
  Effect.gen(function* () {
    const { app, accounts } = yield* selectedApp(executor, owner, input.app);
    if (input.deployment !== undefined && input.deployment !== app.activeDeployment)
      return yield* new DeploymentNotFound({ app: app.id, deployment: input.deployment });
    if (app.activeDeployment === null) return yield* new AppNotDeployed({ app: app.id });
    // Pin the authorized version so a concurrent promotion cannot silently change the call.
    return { deployment: app.activeDeployment, accounts };
  });

/**
 * A tool call's pinned deployment, accounts and kind, after `check` authorizes them. A check that
 * evaluates the app, such as a read-only rule reading the tool's metadata, takes as long as the app
 * does, so the caller's links are read again after it: a link removed or added meanwhile takes
 * effect on the call, as it would on the next one. The call runs with the accounts and the kind
 * checked last. Metadata describes the tool only for the accounts it was read with: when the
 * accounts read again are the same, the first check's metadata decides again without evaluating
 * the app; when they differ, the check reads it again with them.
 */
export const checkedToolCall = <E, R>(
  executor: Executor,
  owner: OwnerId,
  input: { readonly app: AppId; readonly deployment?: DeploymentId | undefined },
  check: (
    selected: { readonly deployment: DeploymentId; readonly accounts: AppAccounts },
    described?: ToolIdentity,
  ) => Effect.Effect<ToolAuthorization, E, R>,
  read?: SelectionReads,
) =>
  Effect.gen(function* () {
    const { app, accounts } = yield* selectedApp(executor, owner, input.app, read);
    if (input.deployment !== undefined && input.deployment !== app.activeDeployment)
      return yield* new DeploymentNotFound({ app: app.id, deployment: input.deployment });
    if (app.activeDeployment === null) return yield* new AppNotDeployed({ app: app.id });
    const deployment = app.activeDeployment;
    const first = yield* check({ deployment, accounts });
    if (first.tool === undefined) return { deployment, accounts, kind: first.kind };
    const live = yield* callerAccounts(app);
    const { kind } = yield* check(
      { deployment, accounts: live },
      sameAccounts(live, accounts) ? first.tool : undefined,
    );
    return { deployment, accounts: live, kind };
  });

/**
 * Background resources run as their saved actor. The actor manages their own, including cleanup
 * after losing access; anyone else needs app management.
 */
export const actorManagerOwner = (app: AppId, actor: string | null) =>
  Effect.gen(function* () {
    const owner = yield* currentOwner;
    if (actor === null || actor !== (yield* CurrentUserId)) yield* requireAppAccess(app, "manage");
    return owner;
  });
/** A connection must still belong to this organization, along with its target app. */
export const ownedConnection = (
  executor: Executor,
  owner: OwnerId,
  connection: AccountConnectionId,
) =>
  Effect.gen(function* () {
    const current = yield* executor.accountConnections.get({ owner, connection });
    yield* executor.apps.get({ owner, app: current.target.app });
    return current;
  });

/** App creators and admins manage settings; this does not authorize account-backed execution. */
export const appManagerOwner = (app: AppId) =>
  requireAppAccess(app, "manage").pipe(Effect.andThen(currentOwner));
/** Metadata reads include separate management access, without selecting credentials. */
export const appReaderOwner = (app: AppId) =>
  requireAppAccess(app, "read").pipe(Effect.andThen(currentOwner));

/**
 * Whether each app requirement's account is still linked to the app for that requirement and
 * usable by it; an unlinked account is refused even when the caller could use it.
 */
const checkAppLinked = (app: AppId, linked: AppAccounts["app"]) =>
  Effect.gen(function* () {
    const used = Object.entries(linked).flatMap(([requirement, ids]) =>
      ids.map((id) => ({ requirement, id })),
    );
    if (used.length === 0) return;
    const current = yield* appLinkedAccounts(yield* policyDatabase, [app]);
    for (const { requirement, id } of used)
      if (!current.some((link) => link.requirement === requirement && link.id === id))
        return yield* new OrganizationForbidden();
  });
/**
 * Retained accounts, by the scope each requirement had when they were captured: the caller's use
 * of each user account, and each app account's current app link. Neither stands in for the other:
 * an app account the caller could use is still refused once unlinked, and a user account the app
 * links now is still checked by the caller's use.
 */
export const checkScopedAccounts = (owner: OwnerId, app: AppId, accounts: AppAccounts) =>
  Effect.gen(function* () {
    yield* checkAccounts(owner, accounts.user ?? {});
    yield* checkAppLinked(app, accounts.app);
  });
/** Pending approvals retain their original accounts even if the caller's links later change. */
export const checkInvocationAccounts = (
  executor: Executor,
  owner: OwnerId,
  invocation: import("@executor-js/sdk/core").ToolInvocation,
) =>
  Effect.gen(function* () {
    yield* executor.apps.get({ owner, app: invocation.app });
    yield* checkScopedAccounts(owner, invocation.app, invocationAccounts(invocation));
  });
