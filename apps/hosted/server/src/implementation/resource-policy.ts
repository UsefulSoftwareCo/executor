/** One authoritative policy for hosted reads, management, credential use, and resumed work. */
import { AccountId, AppId, StorageError, type Account, type App } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { GroupDatabase, GroupId, GroupMemberId } from "../contracts/groups.ts";
import { CurrentUserId, Principal } from "../contracts/auth.ts";
import {
  CurrentOrganization,
  OrganizationForbidden,
  OrganizationId,
  OrganizationRole,
  organizationOwner,
} from "../contracts/organization.ts";
import {
  AccessRevision,
  AppAccess,
  AccountAccess,
  type AppAudience,
  type SharedAudience,
} from "../contracts/resource-access.ts";

/** A concrete client remains owned by this invocation (Cloud) or host process (self-host). */
export const policyDatabase = Effect.flatten(GroupDatabase).pipe(
  Effect.mapError(() => new StorageError()),
);
const Membership = Schema.Struct({ id: GroupMemberId, role: OrganizationRole });
/** Current membership is checked again instead of trusting a captured role or group list. */
export const resourceAuthority = (organization: OrganizationId, user: string | undefined) =>
  Effect.gen(function* () {
    if (user === undefined) return yield* new OrganizationForbidden();
    const sql = yield* policyDatabase;
    const rows =
      yield* sql`select id, role from member where "organizationId" = ${organization} and "userId" = ${user}`;
    const members = yield* Schema.decodeUnknownEffect(Schema.Array(Membership))(rows);
    const member = members[0];
    if (members.length !== 1 || member === undefined) return yield* new OrganizationForbidden();
    return { organization, user, member: member.id, role: member.role };
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );
/** Derive the actor exclusively from the authenticated request context. */
export const currentResourceAuthority = Effect.gen(function* () {
  return yield* resourceAuthority((yield* CurrentOrganization).organization, yield* CurrentUserId);
});
export type ResourceAuthority = Effect.Success<ReturnType<typeof resourceAuthority>>;

const AppPolicy = Schema.Struct({
  app: AppId,
  creator: Schema.NullOr(Principal.fields.userId),
  audience: Schema.Literals(["private", "groups", "everyone"]),
  revision: AccessRevision,
  groups: Schema.Array(GroupId),
  granted: Schema.Boolean,
});
/** Resolve app policies in one read, retaining tenant and group checks for every row. */
const applicationAccesses = (apps: readonly AppId[], actor: ResourceAuthority) =>
  Effect.gen(function* () {
    const sql = yield* policyDatabase;
    const rows = yield* sql`select p.id as app, p.creator_id as creator, p.audience, p.revision,
    array(select g.group_id from hosted_app_groups g where g.app_id = p.id order by g.group_id) as groups,
    exists(select 1 from hosted_app_groups g join hosted_group_members m on m.group_id = g.group_id
      where g.app_id = p.id and m.member_id = ${actor.member}) as granted
    from hosted_app_access p join executor_apps a on a.id = p.id
    where ${sql.in("p.id", apps)} and p.organization_id = ${actor.organization}
      and a.owner = ${`organization:${actor.organization}`}`;
    const policies = yield* Schema.decodeUnknownEffect(Schema.Array(AppPolicy))(rows);
    return policies.map((found) => {
      const audience: typeof AppAudience.Type =
        found.audience === "groups"
          ? { kind: "groups", groups: found.groups }
          : { kind: found.audience };
      return {
        app: found.app,
        creator: found.creator,
        audience,
        revision: found.revision,
        canManage: actor.role !== "member" || found.creator === actor.user,
        canUse:
          found.audience === "private"
            ? found.creator === actor.user
            : found.audience === "everyone" || found.granted,
      } satisfies typeof AppAccess.Type;
    });
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );

/** Resolve one app's policy without evaluating its code; missing policies deny access. */
export const applicationAccess = (app: AppId, actor: ResourceAuthority) =>
  applicationAccesses([app], actor).pipe(
    Effect.flatMap((policies) => {
      const access = policies[0];
      return access === undefined
        ? Effect.fail(new OrganizationForbidden())
        : Effect.succeed(access);
    }),
  );

const AccountPolicy = Schema.Struct({
  account: AccountId,
  creator: Schema.NullOr(Principal.fields.userId),
  kind: Schema.Literals(["personal", "shared"]),
  personalUser: Schema.NullOr(Principal.fields.userId),
  audience: Schema.NullOr(Schema.Literals(["groups", "everyone"])),
  revision: AccessRevision,
  groups: Schema.Array(GroupId),
  granted: Schema.Boolean,
});
/** Read account policies together; personal accounts remain private even from administrators. */
const accountAccesses = (accounts: readonly AccountId[], actor: ResourceAuthority) =>
  Effect.gen(function* () {
    const sql = yield* policyDatabase;
    const rows = yield* sql`select p.account_id as account, p.creator_id as creator, p.kind,
    p.personal_user_id as "personalUser", p.audience, p.revision,
    array(select g.group_id from hosted_account_groups g where g.account_id = p.account_id order by g.group_id) as groups,
    exists(select 1 from hosted_account_groups g join hosted_group_members m on m.group_id = g.group_id
      where g.account_id = p.account_id and m.member_id = ${actor.member}) as granted
    from hosted_account_access p join executor_accounts a on a.id = p.account_id
    where ${sql.in("p.account_id", accounts)} and p.organization_id = ${actor.organization}
      and a.owner = ${`organization:${actor.organization}`}`;
    const policies = yield* Schema.decodeUnknownEffect(Schema.Array(AccountPolicy))(rows);
    return yield* Effect.forEach(policies, (found) =>
      Effect.gen(function* () {
        const account = found.account;
        if (found.kind === "personal") {
          if (found.personalUser === null) return yield* new StorageError();
          return {
            account,
            creator: found.creator,
            revision: found.revision,
            ownership: { kind: "personal", user: found.personalUser },
            canManage: found.personalUser === actor.user,
            canUse: found.personalUser === actor.user,
          } satisfies typeof AccountAccess.Type;
        }
        if (found.audience === null) return yield* new StorageError();
        const audience: typeof SharedAudience.Type =
          found.audience === "groups"
            ? { kind: "groups", groups: found.groups }
            : { kind: "everyone" };
        return {
          account,
          creator: found.creator,
          revision: found.revision,
          ownership: { kind: "shared", audience },
          canManage: actor.role !== "member" || found.creator === actor.user,
          canUse: found.audience === "everyone" || found.granted,
        } satisfies typeof AccountAccess.Type;
      }),
    );
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );

/** Resolve one account's policy; missing policies deny access. */
export const accountAccess = (account: AccountId, actor: ResourceAuthority) =>
  accountAccesses([account], actor).pipe(
    Effect.flatMap((policies) => {
      const access = policies[0];
      return access === undefined
        ? Effect.fail(new OrganizationForbidden())
        : Effect.succeed(access);
    }),
  );

/** Read access may include management; management never authorizes execution. */
export const requireAppAccess = (app: AppId, action: "read" | "manage" | "use") =>
  Effect.flatMap(currentResourceAuthority, (actor) => requireAppAccessAs(actor, app, action));
/** Check app access for an actor already resolved in this operation. */
export const requireAppAccessAs = (
  actor: ResourceAuthority,
  app: AppId,
  action: "read" | "manage" | "use",
) =>
  Effect.gen(function* () {
    const access = yield* applicationAccess(app, actor);
    const allowed =
      action === "use"
        ? access.canUse
        : action === "manage"
          ? access.canManage
          : access.canUse || access.canManage;
    if (!allowed) return yield* new OrganizationForbidden();
    return access;
  });

/** Check current membership and app use in one database snapshot.
 * The app was resolved with its owner before this call. Management never grants use.
 */
export const requireAppUse = (app: App, organization: OrganizationId, user: string) =>
  Effect.gen(function* () {
    if (app.owner !== organizationOwner(organization)) return yield* new OrganizationForbidden();
    const sql = yield* policyDatabase;
    const rows = yield* sql`select m.role from member m
      join hosted_app_access p on p.organization_id = m."organizationId"
      join executor_apps a on a.id = p.id
      where m."organizationId" = ${organization} and m."userId" = ${user}
        and a.id = ${app.id} and a.owner = ${app.owner}
        and (p.audience = 'everyone'
          or (p.audience = 'private' and p.creator_id = ${user})
          or (p.audience = 'groups' and exists (
            select 1 from hosted_app_groups g
            join hosted_group_members gm on gm.group_id = g.group_id
            where g.app_id = p.id and gm.member_id = m.id)))
      `;
    const result = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ role: OrganizationRole })),
    )(rows);
    const member = result[0];
    if (result.length !== 1 || member === undefined) return yield* new OrganizationForbidden();
    return {
      organization,
      owner: organizationOwner(organization),
      role: member.role,
      userId: user,
    };
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
    Effect.withSpan("app.ui.authorize.resources"),
  );
/** Account metadata allows shared-account managers; personal metadata has no admin bypass. */
export const requireAccountAccess = (account: AccountId, action: "read" | "manage" | "use") =>
  Effect.flatMap(currentResourceAuthority, (actor) =>
    requireAccountAccessAs(actor, account, action),
  );
/** Check account access for an actor already resolved in this operation. */
export const requireAccountAccessAs = (
  actor: ResourceAuthority,
  account: AccountId,
  action: "read" | "manage" | "use",
) =>
  Effect.gen(function* () {
    const access = yield* accountAccess(account, actor);
    const allowed =
      action === "use"
        ? access.canUse
        : action === "manage"
          ? access.canManage
          : access.canUse || access.canManage;
    if (!allowed) return yield* new OrganizationForbidden();
    return access;
  });
/** Missing or denied policies are omitted; storage failures remain visible rather than empty lists. */
export const visibleAccounts = (accounts: readonly Account[]) =>
  Effect.gen(function* () {
    const actor = yield* currentResourceAuthority;
    const policies = yield* accountAccesses(
      accounts.map((account) => account.id),
      actor,
    );
    const usable = new Set(
      policies.filter((access) => access.canUse).map((access) => access.account),
    );
    return accounts.filter((account) => usable.has(account.id));
  });
/** Normal app lists contain usable apps, not every app that an admin can manage. */
export const visibleApps = (apps: readonly App[]) =>
  Effect.gen(function* () {
    const actor = yield* currentResourceAuthority;
    const policies = yield* applicationAccesses(
      apps.map((app) => app.id),
      actor,
    );
    const usable = new Set(policies.filter((access) => access.canUse).map((access) => access.app));
    return apps.filter((app) => usable.has(app.id));
  });
