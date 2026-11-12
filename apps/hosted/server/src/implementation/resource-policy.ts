/** One authoritative policy for hosted reads, management, credential use, and resumed work. */
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

/** A concrete client remains owned by this invocation (Cloud) or host process (self-host). */
export const policyDatabase = Effect.flatten(GroupDatabase).pipe(
  Effect.mapError(() => new StorageError()),
);
const Membership = Schema.Struct({ id: GroupMemberId, role: OrganizationRole });
/**
 * The caller's one membership row, `for share` when `lock`. Authority comes from the row this
 * statement returns, so a locked read that waited for a role change returns the committed role.
 */
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
/** Current membership is checked again instead of trusting a captured role or group list. */
export const resourceAuthority = (organization: OrganizationId, user: string | undefined) =>
  membership(organization, user, false);
/** Derive the actor exclusively from the authenticated request context. */
export const currentResourceAuthority = Effect.gen(function* () {
  return yield* resourceAuthority((yield* CurrentOrganization).organization, yield* CurrentUserId);
});
export type ResourceAuthority = Effect.Success<ReturnType<typeof resourceAuthority>>;
/**
 * {@link currentResourceAuthority} read from the caller's membership row as it share-locks it until
 * the transaction ends, so a role change or removal waits for a write that checked it. The role
 * comes from the locked row: one read before the lock could return a role whose change committed
 * while the lock waited. Call it inside the write's transaction, then check access with the `...As`
 * checks below.
 */
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
/** Resolve app policies in one read, retaining tenant and group checks for every row. */
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

const MemberAppPolicy = Schema.Struct({
  ...Membership.fields,
  app: Schema.NullOr(AppId),
  creator: Schema.NullOr(Principal.fields.userId),
  audience: Schema.NullOr(AppPolicy.fields.audience),
  revision: Schema.NullOr(AccessRevision),
  groups: Schema.NullOr(Schema.Array(GroupId)),
  granted: Schema.Boolean,
});
/**
 * {@link resourceAuthority} followed by {@link applicationAccesses}, read in one statement so
 * membership and every policy come from the same snapshot. Membership failures precede missing
 * policies; apps without a policy in the organization are omitted, and callers deny them.
 */
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
    // Every row repeats the one membership; a second membership is ambiguous, as before.
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
/** {@link resourceAuthorityForApps} for one app; a missing policy denies access. */
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

/**
 * The user links a subject has to these apps whose accounts the subject may use now, as the `from`
 * and `where` of a read over `l` (the link) and `a` (the account): the account belongs to the app's
 * organization, the subject is a member, and the account is theirs.
 *
 * The links are read first, with their app's owner, and `offset 0` keeps Postgres from merging that
 * read into the joins after it. Merged, Postgres can reach the apps through the account's owner
 * instead of the link: it then pairs every account of the organization with every app of it and
 * looks up a link for each pair, about 18,000 buffers for one discovery read across 40 apps instead
 * of about 1,000.
 */
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

/**
 * The app links of these apps whose accounts their app requirements may use now, as the `from` and
 * `where` of a read over `l` (the link) and `a` (the account): the account belongs to the app's
 * organization, which holds its access record, and the account's owner is still in it. No
 * caller's use of the account is checked: using an app link follows app access. The links are read
 * first, as in {@link usableLinks}.
 */
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
/** The JSON of one usable link, for a read over {@link usableLinks} or {@link usableAppLinks}. */
export const linkedAccountJson = `json_build_object('app', l.app, 'requirement', l.requirement,
  'id', a.id, 'provider', a.provider, 'label', a.label, 'description', a.description)`;

/** One account linked to an app requirement, which the caller or the app may still use. */
export const LinkedAccount = Schema.Struct({
  app: AppId,
  requirement: Schema.String,
  id: AccountId,
  provider: ProviderId,
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
});
export type LinkedAccount = typeof LinkedAccount.Type;
/** The caller's usable user links to an app and the app's usable app links, oldest first. */
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
/**
 * {@link resourceAuthorityForApp}, the user's links to the app whose accounts they may use now, and
 * the app links whose accounts the app may use now, read in one statement, oldest first. The accounts
 * are decoded when the caller reaches them, so app access is still refused first.
 */
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

/**
 * The accounts among `accounts` that `actor` owns, read together. Every account is personal: only
 * its owner, while still a member, may read, use or manage it; administrators have no bypass.
 */
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
/** Resolve OAuth client policies in one read; only administrators manage clients. */
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

/** Check OAuth client access for an actor already resolved in this operation. */
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

/** Read access may include management; management never authorizes execution. */
export const requireAppAccess = (app: AppId, action: "read" | "manage" | "use") =>
  Effect.map(requireCurrentAppAccess(app, action), ({ access }) => access);
/** Check app access for the request's actor and return both, reading membership once. */
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
/** Check app access for an actor already resolved in this operation. */
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

/** Check current membership and app use in one database snapshot.
 * The app was resolved with its owner before this call. Management never grants use.
 */
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
/**
 * Only an account's owner may read, use or manage it; there is no admin bypass. Missing policies
 * deny access.
 */
export const requireAccountOwner = (account: AccountId) =>
  Effect.flatMap(currentResourceAuthority, (actor) => requireAccountOwnerAs(actor, account));
/** Check account ownership for an actor already resolved in this operation. */
export const requireAccountOwnerAs = (actor: ResourceAuthority, account: AccountId) =>
  Effect.gen(function* () {
    if (!(yield* ownedAccountIds([account], actor)).has(account))
      return yield* new OrganizationForbidden();
  });
/** Missing or denied policies are omitted; storage failures remain visible rather than empty lists. */
export const visibleAccounts = (accounts: readonly Account[]) =>
  Effect.flatMap(currentResourceAuthority, (actor) => visibleAccountsAs(actor, accounts));
/** {@link visibleAccounts} for an actor already resolved in this operation. */
export const visibleAccountsAs = (actor: ResourceAuthority, accounts: readonly Account[]) =>
  Effect.gen(function* () {
    const owned = yield* ownedAccountIds(
      accounts.map((account) => account.id),
      actor,
    );
    return accounts.filter((account) => owned.has(account.id));
  });
/**
 * Normal app lists contain usable apps, not every app that an admin can manage. Membership and the
 * policies are read in one statement.
 */
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
/** {@link visibleApps} for an actor already resolved in this operation. */
export const visibleAppsAs = (actor: ResourceAuthority, apps: readonly App[]) =>
  Effect.gen(function* () {
    const policies = yield* applicationAccesses(
      apps.map((app) => app.id),
      actor,
    );
    const usable = new Set(policies.filter((access) => access.canUse).map((access) => access.app));
    return apps.filter((app) => usable.has(app.id));
  });
