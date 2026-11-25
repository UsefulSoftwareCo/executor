import {
  AccountNotFound,
  AppNotDeployed,
  VersionNotFound,
  invocationAccounts,
  sameAccounts,
} from "@executor-js/sdk/core";
import {
  requireAppAccess,
  requireCurrentAppAccess,
  ownedAccountIds,
  currentResourceAuthority,
  policyDatabase,
  resourceAuthorityForApp,
  resourceAuthorityForLinks,
  type AppAccountReads,
  type ResourceAuthority,
} from "./resource-policy.ts";
import type { AppAccess } from "../contracts/resource-access.ts";
import type {
  App,
  AppAccounts,
  AppId,
  AccountConnectionId,
  VersionId,
  Executor,
  OwnerId,
  SelectedAccounts,
} from "@executor-js/sdk/core";
import type { ToolIdentity } from "@executor-js/authorization";
import type { ToolAuthorization } from "./authorization.ts";
import { Context, Effect, type Exit, Result } from "effect";
import { HttpServerRequest } from "effect/http";
import {
  BearerAuthentication,
  CurrentUserId,
  Forbidden,
  SessionAuthentication,
} from "../contracts/auth.ts";
import { refuse } from "./auth-telemetry.ts";
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

export const browserOnly = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers.authorization !== undefined)
    return yield* refuse("bearer_not_allowed", new Forbidden());
});
export const currentOrganizationSlug = (
  auth: SessionAuthentication["Service"],
  api: BearerAuthentication["Service"],
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const headers = new Headers(request.headers);
    const { organization } = yield* CurrentOrganization;
    return headers.has("authorization")
      ? (yield* api.authenticate(headers, organization)).organizationSlug
      : yield* auth.organizationSlug(headers, organization);
  });
export const requireOrganizationAdmin = Effect.gen(function* () {
  const organization = yield* CurrentOrganization;
  if (organization.role === "member")
    return yield* refuse("insufficient_role", new OrganizationForbidden());
  return organization;
});
export const requireOrganizationOwner = Effect.gen(function* () {
  const organization = yield* CurrentOrganization;
  if (organization.role !== "owner")
    return yield* refuse("insufficient_role", new OrganizationForbidden());
  return organization;
});
export const currentOwner = Effect.map(CurrentOrganization, (organization) => organization.owner);
export const adminOwner = Effect.map(
  requireOrganizationAdmin,
  (organization) => organization.owner,
);

export const checkAccounts = (owner: OwnerId, accounts: SelectedAccounts) =>
  Effect.flatMap(currentResourceAuthority, (actor) => checkAccountsAs(actor, owner, accounts));
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
    const owned = yield* ownedAccountIds([...new Set(selected)], actor);
    for (const account of selected) {
      if (!owned.has(account)) return yield* new OrganizationForbidden();
      if (owner !== organizationOwner(actor.organization))
        return yield* new AccountNotFound({ account });
    }
  });
export const usableApp = (executor: Executor, owner: OwnerId, app: AppId) =>
  Effect.gen(function* () {
    yield* requireCurrentAppAccess(app, "use");
    return yield* executor.apps.get({ owner, app });
  });
export interface SelectionReads {
  readonly owner: OwnerId;
  readonly app: AppId;
  readonly current: Result.Result<App, Effect.Error<ReturnType<Executor["apps"]["get"]>>>;
}
const answered = <A, E extends { readonly _tag: string }>(read: Result.Result<A, E>) =>
  Result.isSuccess(read) || read.failure._tag !== "StorageError";
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
export const SelectionReadAhead = Context.Reference<SelectionReads | undefined>(
  "hosted/SelectionReadAhead",
  { defaultValue: () => undefined },
);
export const readSelection = (executor: Executor, owner: OwnerId, app: AppId) =>
  Effect.map(Effect.result(executor.apps.get({ owner, app })), (current): SelectionReads => ({
    owner,
    app,
    current,
  }));
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
          ? yield* resourceAuthorityForApp(organization, user, app).pipe(
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
export const selectedVersion = (
  executor: Executor,
  owner: OwnerId,
  input: { readonly app: AppId; readonly version?: VersionId | undefined },
) =>
  Effect.gen(function* () {
    const { app: current, linked } = yield* usableAppWithLinks(executor, owner, input.app);
    if (input.version === undefined || input.version === current.activeVersion)
      return yield* callerAccounts(current, linked);
    const retained = yield* executor.apps.version({
      owner,
      app: input.app,
      version: input.version,
    });
    return yield* versionAccounts(
      { app: current.id, version: retained.id, requirements: retained.requirements },
      linked,
    );
  });
export const pinnedActiveVersion = (
  selected: { readonly app: App; readonly accounts: AppAccounts },
  version: VersionId | undefined,
) =>
  Effect.gen(function* () {
    const { app, accounts } = selected;
    if (version !== undefined && version !== app.activeVersion)
      return yield* new VersionNotFound({ app: app.id, version });
    if (app.activeVersion === null) return yield* new AppNotDeployed({ app: app.id });
    return { version: app.activeVersion, accounts };
  });
export const selectedActiveVersion = (
  executor: Executor,
  owner: OwnerId,
  input: { readonly app: AppId; readonly version?: VersionId | undefined },
) =>
  Effect.flatMap(selectedApp(executor, owner, input.app), (selected) =>
    pinnedActiveVersion(selected, input.version),
  );
export const selectedAppFrom = (
  app: App,
  access: typeof AppAccess.Type | undefined,
  links: AppAccountReads,
) =>
  Effect.gen(function* () {
    if (access === undefined || !access.canUse) return yield* new OrganizationForbidden();
    return { app, accounts: yield* callerAccounts(app, Effect.succeed(links)) };
  });

export const checkedToolCall = <E, R>(
  executor: Executor,
  owner: OwnerId,
  input: { readonly app: AppId; readonly version?: VersionId | undefined },
  check: (
    selected: { readonly version: VersionId; readonly accounts: AppAccounts },
    described?: ToolIdentity,
  ) => Effect.Effect<ToolAuthorization, E, R>,
  read?: SelectionReads,
) =>
  Effect.gen(function* () {
    const { app, accounts } = yield* selectedApp(executor, owner, input.app, read);
    if (input.version !== undefined && input.version !== app.activeVersion)
      return yield* new VersionNotFound({ app: app.id, version: input.version });
    if (app.activeVersion === null) return yield* new AppNotDeployed({ app: app.id });
    const version = app.activeVersion;
    const first = yield* check({ version, accounts });
    if (first.tool === undefined) return { version, accounts, kind: first.kind };
    const live = yield* callerAccounts(app);
    const { kind } = yield* check(
      { version, accounts: live },
      sameAccounts(live, accounts) ? first.tool : undefined,
    );
    return { version, accounts: live, kind };
  });

export const actorManagerOwner = (app: AppId, actor: string | null) =>
  Effect.gen(function* () {
    const owner = yield* currentOwner;
    if (actor === null || actor !== (yield* CurrentUserId)) yield* requireAppAccess(app, "manage");
    return owner;
  });
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

export const appManagerOwner = (app: AppId) =>
  requireAppAccess(app, "manage").pipe(Effect.andThen(currentOwner));
export const appReaderOwner = (app: AppId) =>
  requireAppAccess(app, "read").pipe(Effect.andThen(currentOwner));

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
export const checkScopedAccounts = (owner: OwnerId, app: AppId, accounts: AppAccounts) =>
  Effect.flatMap(currentResourceAuthority, (actor) =>
    checkScopedAccountsAs(actor, owner, app, accounts),
  );
export const checkScopedAccountsAs = (
  actor: ResourceAuthority,
  owner: OwnerId,
  app: AppId,
  accounts: AppAccounts,
) =>
  Effect.gen(function* () {
    yield* checkAccountsAs(actor, owner, accounts.user ?? {});
    yield* checkAppLinked(app, accounts.app);
  });
export const checkInvocationAccounts = (
  executor: Executor,
  owner: OwnerId,
  invocation: import("@executor-js/sdk/core").ToolInvocation,
) =>
  Effect.gen(function* () {
    yield* executor.apps.get({ owner, app: invocation.app });
    yield* checkScopedAccounts(owner, invocation.app, invocationAccounts(invocation));
  });
