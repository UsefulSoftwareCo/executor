import {
  AccountId,
  AppId,
  OAuthClientId,
  ProviderId,
  StorageError,
  type Account,
  type App,
} from "@executor-js/sdk/core";
import type { OAuthClientAccess } from "../contracts/oauth-clients.ts";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { GroupDatabase, GroupId, GroupMemberId } from "../contracts/groups.ts";
import { CurrentUserId, Principal } from "../contracts/auth.ts";
import {
  CurrentOrganization,
  OrganizationForbidden,
  OrganizationId,
  OrganizationRole,
  organizationOwner,
} from "../contracts/organization.ts";
import { AccessRevision, AppAccess, type AppAudience } from "../contracts/resource-access.ts";

export const policyDatabase = Effect.flatten(GroupDatabase).pipe(
  Effect.mapError(() => new StorageError()),
);
const Membership = Schema.Struct({ id: GroupMemberId, role: OrganizationRole });
const membership = (organization: OrganizationId, user: string | undefined, lock: boolean) =>
  Effect.gen(function* () {
    if (user === undefined) return yield* new OrganizationForbidden();
    const sql = yield* policyDatabase;
    const rows = yield* sql`select id, role from member
      where "organizationId" = ${organization} and "userId" = ${user}${lock ? sql` for share` : sql``}`;
    const members = yield* Schema.decodeUnknownEffect(Schema.Array(Membership))(rows);
    const member = members[0];
    if (members.length !== 1 || member === undefined) return yield* new OrganizationForbidden();
    return { organization, user, member: member.id, role: member.role };
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );
export const resourceAuthority = (organization: OrganizationId, user: string | undefined) =>
  membership(organization, user, false);
export const currentResourceAuthority = Effect.gen(function* () {
  return yield* resourceAuthority((yield* CurrentOrganization).organization, yield* CurrentUserId);
});
export type ResourceAuthority = Effect.Success<ReturnType<typeof resourceAuthority>>;
export const lockCurrentActor = Effect.gen(function* () {
  return yield* membership((yield* CurrentOrganization).organization, yield* CurrentUserId, true);
});

const AppPolicy = Schema.Struct({
  app: AppId,
  creator: Schema.NullOr(Principal.fields.userId),
  audience: Schema.Literals(["private", "groups", "everyone"]),
  revision: AccessRevision,
  groups: Schema.Array(GroupId),
  granted: Schema.Boolean,
});
const appAccessOf = (found: typeof AppPolicy.Type, actor: ResourceAuthority) => {
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
};
export const applicationAccesses = (apps: readonly AppId[], actor: ResourceAuthority) =>
  Effect.gen(function* () {
    if (apps.length === 0) return [];
    const sql = yield* policyDatabase;
    const rows = yield* sql`select p.id as app, p.creator_id as creator, p.audience, p.revision,
    array(select g.group_id from hosted_app_groups g where g.app_id = p.id order by g.group_id) as groups,
    exists(select 1 from hosted_app_groups g join hosted_group_members m on m.group_id = g.group_id
      where g.app_id = p.id and m.member_id = ${actor.member}) as granted
    from hosted_app_access p
    where ${sql.in("p.id", apps)} and p.organization_id = ${actor.organization}`;
    const policies = yield* Schema.decodeUnknownEffect(Schema.Array(AppPolicy))(rows);
    return policies.map((found) => appAccessOf(found, actor));
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );

export const applicationAccess = (app: AppId, actor: ResourceAuthority) =>
  applicationAccesses([app], actor).pipe(
    Effect.flatMap((policies) => {
      const access = policies[0];
      return access === undefined
        ? Effect.fail(new OrganizationForbidden())
        : Effect.succeed(access);
    }),
  );

const MemberAppPolicy = Schema.Struct({
  ...Membership.fields,
  app: Schema.NullOr(AppId),
  creator: Schema.NullOr(Principal.fields.userId),
  audience: Schema.NullOr(AppPolicy.fields.audience),
  revision: Schema.NullOr(AccessRevision),
  groups: Schema.NullOr(Schema.Array(GroupId)),
  granted: Schema.Boolean,
});
export const resourceAuthorityForApps = (
  organization: OrganizationId,
  user: string | undefined,
  apps: readonly AppId[],
) =>
  Effect.gen(function* () {
    if (user === undefined) return yield* new OrganizationForbidden();
    const sql = yield* policyDatabase;
    const rows = yield* sql`select m.id, m.role, p.id as app, p.creator_id as creator, p.audience,
    p.revision,
    case when p.id is null then null else
      array(select g.group_id from hosted_app_groups g where g.app_id = p.id order by g.group_id)
    end as groups,
    exists(select 1 from hosted_app_groups g join hosted_group_members gm on gm.group_id = g.group_id
      where g.app_id = p.id and gm.member_id = m.id) as granted
    from member m
    left join hosted_app_access p on ${sql.in("p.id", apps)} and p.organization_id = m."organizationId"
    where m."organizationId" = ${organization} and m."userId" = ${user}`;
    const found = yield* Schema.decodeUnknownEffect(Schema.Array(MemberAppPolicy))(rows);
    const row = found[0];
    if (row === undefined || found.some((other) => other.id !== row.id))
      return yield* new OrganizationForbidden();
    const actor = { organization, user, member: row.id, role: row.role };
    const access = found.flatMap((policy) =>
      policy.app === null ||
      policy.audience === null ||
      policy.revision === null ||
      policy.groups === null
        ? []
        : [
            appAccessOf(
              {
                app: policy.app,
                creator: policy.creator,
                audience: policy.audience,
                revision: policy.revision,
                groups: policy.groups,
                granted: policy.granted,
              },
              actor,
            ),
          ],
    );
    return { actor, access };
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );
export const resourceAuthorityForApp = (
  organization: OrganizationId,
  user: string | undefined,
  app: AppId,
) =>
  Effect.gen(function* () {
    const { actor, access } = yield* resourceAuthorityForApps(organization, user, [app]);
    const [policy] = access;
    if (policy === undefined) return yield* new OrganizationForbidden();
    return { actor, access: policy };
  });

export const usableLinks = (
  sql: SqlClient.SqlClient,
  input: { readonly subject: string; readonly apps: readonly AppId[] },
) => sql`(select l.app, l.requirement, l.account, l.subject, l.created_at, app.owner
        from hosted_app_account_links l
        join executor_apps app on app.id = l.app
        where l.subject = ${input.subject} and ${sql.in("l.app", input.apps)}
        offset 0) l
      join executor_accounts a on a.id = l.account and a.owner = l.owner
      join hosted_account_access p on p.account_id = a.id
        and a.owner = 'organization:' || p.organization_id
      join member m on m."organizationId" = p.organization_id and m."userId" = l.subject
      where p.personal_user_id = m."userId"`;

export const usableAppLinks = (sql: SqlClient.SqlClient, apps: readonly AppId[]) =>
  sql`(select l.app, l.requirement, l.account, l.created_at, app.owner
        from hosted_app_account_links l
        join executor_apps app on app.id = l.app
        where l.subject is null and ${sql.in("l.app", apps)}
        offset 0) l
      join executor_accounts a on a.id = l.account and a.owner = l.owner
      join hosted_account_access p on p.account_id = a.id
        and a.owner = 'organization:' || p.organization_id
      where exists(select 1 from member owner_member
          where owner_member."organizationId" = p.organization_id
            and owner_member."userId" = p.personal_user_id)`;
export const linkedAccountJson = `json_build_object('app', l.app, 'requirement', l.requirement,
  'id', a.id, 'provider', a.provider, 'label', a.label, 'description', a.description)`;

export const LinkedAccount = Schema.Struct({
  app: AppId,
  requirement: Schema.String,
  id: AccountId,
  provider: ProviderId,
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
});
export type LinkedAccount = typeof LinkedAccount.Type;
export const AppAccountReads = Schema.Struct({
  user: Schema.Array(LinkedAccount),
  app: Schema.Array(LinkedAccount),
});
export type AppAccountReads = typeof AppAccountReads.Type;

const MemberLinksPolicy = Schema.Struct({
  ...MemberAppPolicy.fields,
  userLinks: Schema.String,
  appLinks: Schema.String,
});
export const resourceAuthorityForLinks = (
  organization: OrganizationId,
  user: string | undefined,
  app: AppId,
) =>
  Effect.gen(function* () {
    if (user === undefined) return yield* new OrganizationForbidden();
    const sql = yield* policyDatabase;
    const rows = yield* sql`select m.id, m.role, p.id as app, p.creator_id as creator, p.audience,
    p.revision,
    case when p.id is null then null else
      array(select g.group_id from hosted_app_groups g where g.app_id = p.id order by g.group_id)
    end as groups,
    exists(select 1 from hosted_app_groups g join hosted_group_members gm on gm.group_id = g.group_id
      where g.app_id = p.id and gm.member_id = m.id) as granted,
    (select coalesce(json_agg(${sql.literal(linkedAccountJson)} order by l.created_at, a.id),
      '[]'::json)::text from ${usableLinks(sql, { subject: user, apps: [app] })}) as "userLinks",
    (select coalesce(json_agg(${sql.literal(linkedAccountJson)} order by l.created_at, a.id),
      '[]'::json)::text from ${usableAppLinks(sql, [app])}) as "appLinks"
    from member m
    left join hosted_app_access p on p.id = ${app} and p.organization_id = m."organizationId"
    where m."organizationId" = ${organization} and m."userId" = ${user}`;
    const found = yield* Schema.decodeUnknownEffect(Schema.Array(MemberLinksPolicy))(rows);
    const row = found[0];
    if (found.length !== 1 || row === undefined) return yield* new OrganizationForbidden();
    const actor = { organization, user, member: row.id, role: row.role };
    if (row.app === null || row.audience === null || row.revision === null || row.groups === null)
      return yield* new OrganizationForbidden();
    return {
      actor,
      access: appAccessOf(
        {
          app: row.app,
          creator: row.creator,
          audience: row.audience,
          revision: row.revision,
          groups: row.groups,
          granted: row.granted,
        },
        actor,
      ),
      accounts: Effect.all({
        user: Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(LinkedAccount)))(
          row.userLinks,
        ),
        app: Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(LinkedAccount)))(
          row.appLinks,
        ),
      }).pipe(Effect.mapError(() => new StorageError())),
    };
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );

const MemberPoliciesLinks = Schema.Struct({
  ...Membership.fields,
  policies: Schema.fromJsonString(Schema.Array(AppPolicy)),
  userLinks: Schema.fromJsonString(Schema.Array(LinkedAccount)),
  appLinks: Schema.fromJsonString(Schema.Array(LinkedAccount)),
});
export const resourceAuthorityForAppsWithLinks = (
  organization: OrganizationId,
  user: string | undefined,
  apps: readonly [AppId, ...AppId[]],
) =>
  Effect.gen(function* () {
    if (user === undefined) return yield* new OrganizationForbidden();
    const sql = yield* policyDatabase;
    const json = sql.literal(linkedAccountJson);
    const rows = yield* sql`select m.id, m.role,
    (select coalesce(json_agg(json_build_object('app', p.id, 'creator', p.creator_id,
        'audience', p.audience, 'revision', p.revision,
        'groups', array(select g.group_id from hosted_app_groups g where g.app_id = p.id
          order by g.group_id),
        'granted', exists(select 1 from hosted_app_groups g
          join hosted_group_members gm on gm.group_id = g.group_id
          where g.app_id = p.id and gm.member_id = m.id))), '[]'::json)::text
      from hosted_app_access p
      where ${sql.in("p.id", apps)} and p.organization_id = m."organizationId") as policies,
    (select coalesce(json_agg(${json} order by l.created_at, a.id), '[]'::json)::text
      from ${usableLinks(sql, { subject: user, apps })}) as "userLinks",
    (select coalesce(json_agg(${json} order by l.created_at, a.id), '[]'::json)::text
      from ${usableAppLinks(sql, apps)}) as "appLinks"
    from member m
    where m."organizationId" = ${organization} and m."userId" = ${user}`;
    const found = yield* Schema.decodeUnknownEffect(Schema.Array(MemberPoliciesLinks))(rows);
    const row = found[0];
    if (found.length !== 1 || row === undefined) return yield* new OrganizationForbidden();
    const actor = { organization, user, member: row.id, role: row.role };
    return {
      actor,
      access: row.policies.map((policy) => appAccessOf(policy, actor)),
      links: { user: row.userLinks, app: row.appLinks } satisfies AppAccountReads,
    };
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );

export const ownedAccountIds = (accounts: readonly AccountId[], actor: ResourceAuthority) =>
  Effect.gen(function* () {
    if (accounts.length === 0) return new Set<AccountId>();
    const sql = yield* policyDatabase;
    const rows = yield* sql`select p.account_id as account
    from hosted_account_access p
    where ${sql.in("p.account_id", accounts)} and p.organization_id = ${actor.organization}
      and p.personal_user_id = ${actor.user}`;
    const owned = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ account: AccountId })),
    )(rows);
    return new Set(owned.map((found) => found.account));
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );

const OAuthClientPolicy = Schema.Struct({
  client: OAuthClientId,
  creator: Schema.NullOr(Principal.fields.userId),
  audience: Schema.Literals(["private", "groups", "everyone"]),
  revision: AccessRevision,
  groups: Schema.Array(GroupId),
  granted: Schema.Boolean,
});
export const oauthClientAccesses = (clients: readonly OAuthClientId[], actor: ResourceAuthority) =>
  Effect.gen(function* () {
    if (clients.length === 0) return [];
    const sql = yield* policyDatabase;
    const rows =
      yield* sql`select p.client_id as client, p.creator_id as creator, p.audience, p.revision,
    array(select g.group_id from hosted_oauth_client_groups g where g.client_id = p.client_id order by g.group_id) as groups,
    exists(select 1 from hosted_oauth_client_groups g join hosted_group_members m on m.group_id = g.group_id
      where g.client_id = p.client_id and m.member_id = ${actor.member}) as granted
    from hosted_oauth_client_access p
    where ${sql.in("p.client_id", clients)} and p.organization_id = ${actor.organization}`;
    const policies = yield* Schema.decodeUnknownEffect(Schema.Array(OAuthClientPolicy))(rows);
    return policies.map((found) => {
      const audience: typeof AppAudience.Type =
        found.audience === "groups"
          ? { kind: "groups", groups: found.groups }
          : { kind: found.audience };
      return {
        client: found.client,
        creator: found.creator,
        audience,
        revision: found.revision,
        canManage: actor.role !== "member",
        canUse:
          found.audience === "private"
            ? found.creator === actor.user
            : found.audience === "everyone" || found.granted,
      } satisfies OAuthClientAccess;
    });
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );

export const requireOAuthClientAccessAs = (
  actor: ResourceAuthority,
  client: OAuthClientId,
  action: "manage" | "use",
) =>
  Effect.gen(function* () {
    const access = (yield* oauthClientAccesses([client], actor))[0];
    if (access === undefined || !(action === "use" ? access.canUse : access.canManage))
      return yield* new OrganizationForbidden();
    return access;
  });

export const requireAppAccess = (app: AppId, action: "read" | "manage" | "use") =>
  Effect.map(requireCurrentAppAccess(app, action), ({ access }) => access);
export const requireCurrentAppAccess = (app: AppId, action: "read" | "manage" | "use") =>
  Effect.gen(function* () {
    const checked = yield* resourceAuthorityForApp(
      (yield* CurrentOrganization).organization,
      yield* CurrentUserId,
      app,
    );
    if (!permitsAppAction(checked.access, action)) return yield* new OrganizationForbidden();
    return checked;
  });
const permitsAppAction = (access: typeof AppAccess.Type, action: "read" | "manage" | "use") =>
  action === "use"
    ? access.canUse
    : action === "manage"
      ? access.canManage
      : access.canUse || access.canManage;
export const requireAppAccessAs = (
  actor: ResourceAuthority,
  app: AppId,
  action: "read" | "manage" | "use",
) =>
  Effect.gen(function* () {
    const access = yield* applicationAccess(app, actor);
    if (!permitsAppAction(access, action)) return yield* new OrganizationForbidden();
    return access;
  });

export const requireAppUse = (app: App, organization: OrganizationId, user: string) =>
  Effect.gen(function* () {
    if (app.owner !== organizationOwner(organization)) return yield* new OrganizationForbidden();
    const sql = yield* policyDatabase;
    const rows = yield* sql`select m.role from member m
      join hosted_app_access p on p.organization_id = m."organizationId"
      where m."organizationId" = ${organization} and m."userId" = ${user}
        and p.id = ${app.id}
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
export const requireAccountOwner = (account: AccountId) =>
  Effect.flatMap(currentResourceAuthority, (actor) => requireAccountOwnerAs(actor, account));
export const requireAccountOwnerAs = (actor: ResourceAuthority, account: AccountId) =>
  Effect.gen(function* () {
    if (!(yield* ownedAccountIds([account], actor)).has(account))
      return yield* new OrganizationForbidden();
  });
export const visibleAccounts = (accounts: readonly Account[]) =>
  Effect.flatMap(currentResourceAuthority, (actor) => visibleAccountsAs(actor, accounts));
export const visibleAccountsAs = (actor: ResourceAuthority, accounts: readonly Account[]) =>
  Effect.gen(function* () {
    const owned = yield* ownedAccountIds(
      accounts.map((account) => account.id),
      actor,
    );
    return accounts.filter((account) => owned.has(account.id));
  });
export const visibleApps = (apps: readonly App[]) =>
  Effect.gen(function* () {
    const { access } = yield* resourceAuthorityForApps(
      (yield* CurrentOrganization).organization,
      yield* CurrentUserId,
      apps.map((app) => app.id),
    );
    const usable = new Set(access.filter((policy) => policy.canUse).map((policy) => policy.app));
    return apps.filter((app) => usable.has(app.id));
  });
export const visibleAppsAs = (actor: ResourceAuthority, apps: readonly App[]) =>
  Effect.gen(function* () {
    const policies = yield* applicationAccesses(
      apps.map((app) => app.id),
      actor,
    );
    const usable = new Set(policies.filter((access) => access.canUse).map((access) => access.app));
    return apps.filter((app) => usable.has(app.id));
  });
