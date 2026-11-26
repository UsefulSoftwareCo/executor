import { isContributed, checkContributedAccountRemoval } from "./contributed-account-policy.ts";
/** Product metadata commits with SDK resources using the same SQL transaction context. */
import {
  AccountConnectionRefused,
  AccountConnectionTargetChanged,
  AccountId,
  AccountScope,
  AppId,
  StorageError,
  StorageHost,
  type Account,
  type Executor,
  type ResourceLifecycle,
  type OwnerId,
} from "@executor-js/sdk/core";
import { Context, Effect, Option, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { CurrentUserId } from "../contracts/auth.ts";
import { OrganizationId } from "../contracts/organization.ts";
import type { AppAudience } from "../contracts/resource-access.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";

import { requireGroupSharing } from "./group-sharing.ts";
import {
  addLink,
  appLinkApps,
  appLinkedAccounts,
  linkedAccounts,
  sourceActorLost,
} from "./app-accounts.ts";
import { usableAppLinks } from "./resource-policy.ts";

type AppCreation =
  | { readonly kind: "member" }
  | { readonly kind: "system" }
  | { readonly kind: "copy"; readonly from: AppId };
const AppCreation = Context.Reference<AppCreation>("hosted/AppCreation", {
  defaultValue: () => ({ kind: "member" }),
});
type AccountCreation =
  | { readonly kind: "member" }
  | { readonly kind: "attributed"; readonly user: string };
const AccountCreation = Context.Reference<AccountCreation>("hosted/AccountCreation", {
  defaultValue: () => ({ kind: "member" }),
});
export const copiedAppCreation =
  (from: AppId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(AppCreation, { kind: "copy", from }));
export const organizationAppCreation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AppCreation, { kind: "system" }));
export const personalAccountCreation =
  (user: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(AccountCreation, { kind: "attributed", user }));

type OAuthClientCreation =
  | { readonly kind: "member"; readonly audience: typeof AppAudience.Type }
  | { readonly kind: "system" };
const OAuthClientCreation = Context.Reference<OAuthClientCreation>("hosted/OAuthClientCreation", {
  defaultValue: () => ({ kind: "system" }),
});
export const oauthClientAudience =
  (audience: typeof AppAudience.Type) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(OAuthClientCreation, { kind: "member", audience }));

const organizationOf = (owner: OwnerId) =>
  owner.startsWith("organization:")
    ? Schema.decodeUnknownEffect(OrganizationId)(owner.slice("organization:".length)).pipe(
        Effect.mapError(() => new StorageError()),
      )
    : Effect.fail(new StorageError());

const appsUse = (
  sql: SqlClient.SqlClient,
  input: {
    readonly ids: readonly AppId[];
    readonly organization: OrganizationId;
    readonly actor: string;
  },
) => sql`select p.id from hosted_app_access p join member m
      on m."organizationId" = p.organization_id and m."userId" = ${input.actor}
      where ${sql.in("p.id", input.ids)} and p.organization_id = ${input.organization}
      and ((p.audience = 'private' and p.creator_id = m."userId") or p.audience = 'everyone'
        or (p.audience = 'groups' and exists(select 1 from hosted_app_groups g
          join hosted_group_members gm on gm.group_id = g.group_id
          where g.app_id = p.id and gm.member_id = m.id)))`;
const appUse = (
  sql: SqlClient.SqlClient,
  input: { readonly id: AppId; readonly organization: OrganizationId; readonly actor: string },
) => appsUse(sql, { ids: [input.id], organization: input.organization, actor: input.actor });

export const actorUsesApp = (
  sql: SqlClient.SqlClient,
  input: { readonly id: AppId; readonly owner: OwnerId; readonly actor: string },
) =>
  Effect.gen(function* () {
    const organization = yield* organizationOf(input.owner);
    const rows = yield* appUse(sql, { ...input, organization });
    return rows.length === 1;
  }).pipe(Effect.catchTag("SqlError", () => new StorageError()));

type AccountOwner = Pick<Account, "id" | "owner">;
const organizationAccounts = <A extends AccountOwner>(accounts: readonly A[]) =>
  accounts.filter(
    (account) =>
      account.owner.startsWith("organization:") &&
      Schema.is(OrganizationId)(account.owner.slice("organization:".length)),
  );
const accountAccess = (sql: SqlClient.SqlClient, accounts: readonly AccountOwner[], user: string) =>
  sql`select p.account_id as id, 'organization:' || p.organization_id as owner
        from hosted_account_access p
        where ${sql.in(
          "p.account_id",
          accounts.map((account) => account.id),
        )}
        and p.personal_user_id = ${user}
        and exists(select 1 from member m
          where m."organizationId" = p.organization_id and m."userId" = ${user})`;
const AllowedAccount = Schema.Struct({ id: AccountId, owner: Schema.String });
type AllowedAccount = typeof AllowedAccount.Type;
const AllowedUse = Schema.Struct({ requirement: Schema.String, id: AccountId });
const AppRecheck = Schema.Struct({
  access: Schema.Number,
  accounts: Schema.fromJsonString(Schema.Array(AllowedAccount)),
  appLinks: Schema.fromJsonString(Schema.Array(AllowedUse)),
});
const AppsRecheck = Schema.Struct({
  access: Schema.fromJsonString(Schema.Array(AppId)),
  accounts: AppRecheck.fields.accounts,
  appLinks: Schema.fromJsonString(
    Schema.Array(Schema.Struct({ ...AllowedUse.fields, app: AppId })),
  ),
});
const allowedOf = (accounts: readonly AccountOwner[], allowed: ReadonlyArray<AllowedAccount>) => {
  const owners = new Map(accounts.map((account) => [account.id, account.owner]));
  return new Set(allowed.filter((row) => owners.get(row.id) === row.owner).map((row) => row.id));
};
type AppUse = Parameters<ResourceLifecycle["appResolving"]>[2][number];
const useKey = (requirement: string, account: AccountId) => JSON.stringify([requirement, account]);
const passedEvery = (
  accounts: readonly AccountOwner[],
  appUses: readonly AppUse[],
  users: ReadonlySet<AccountId>,
  uses: ReadonlySet<string>,
) => {
  const ids = new Set([
    ...accounts.map((account) => account.id),
    ...appUses.map((use) => use.account.id),
  ]);
  return new Set(
    [...ids].filter(
      (id) =>
        (!accounts.some((account) => account.id === id) || users.has(id)) &&
        appUses
          .filter((use) => use.account.id === id)
          .every((use) => uses.has(useKey(use.requirement, id))),
    ),
  );
};
const noRows = "'[]'::text";

export const hostedResourceLifecycle = Effect.gen(function* () {
  const created: { executor?: Executor; requireVerifiedEmail?: boolean | undefined } = {};
  const executor = Effect.suspend(() =>
    created.executor === undefined
      ? Effect.fail(new StorageError())
      : Effect.succeed(created.executor),
  );
  const webhooks = Effect.map(executor, (executor) => executor.webhooks);
  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(executor, (executor) => executor[StorageHost].transaction(effect));
  const hooks = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const member = (organization: OrganizationId, user: string | undefined) =>
      Effect.gen(function* () {
        if (user === undefined) return yield* new StorageError();
        const rows =
          yield* sql`select id from member where "organizationId" = ${organization} and "userId" = ${user} for share`;
        if (rows.length !== 1) return yield* new StorageError();
        return user;
      });
    const lifecycle: ResourceLifecycle = {
      userLinks: (input) =>
        linkedAccounts(sql, { subject: input.subject, apps: [input.app] }).pipe(
          Effect.map((linked) =>
            linked.map((link) => ({ requirement: link.requirement, account: link.id })),
          ),
        ),
      sourceActorLost: (input) =>
        Effect.flatMap(webhooks, (sources) =>
          transaction(sourceActorLost(sql, sources, input)),
        ).pipe(
          Effect.andThen(
            Effect.serviceOption(ScheduleWakeup).pipe(
              Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (wake) => wake })),
            ),
          ),
        ),
      appLinks: (input) =>
        appLinkedAccounts(sql, [input.app]).pipe(
          Effect.map((linked) =>
            linked.map((link) => ({ requirement: link.requirement, account: link.id })),
          ),
        ),
      appResolving: (app, accounts, appUses) =>
        Effect.gen(function* () {
          const user = yield* CurrentUserId;
          const organization = yield* organizationOf(app.owner);
          const owned = user === undefined ? [] : organizationAccounts(accounts);
          const uses = appUses.filter((use) => use.account.owner === app.owner);
          const access =
            user === undefined
              ? sql`select p.id from hosted_app_access p
                  where p.id = ${app.id} and p.organization_id = ${organization}`
              : appUse(sql, { id: app.id, organization, actor: user });
          const users =
            user === undefined || owned.length === 0
              ? sql.literal(noRows)
              : sql`(select coalesce(json_agg(allowed), '[]'::json)::text
                  from (${accountAccess(sql, owned, user)}) allowed)`;
          const linkRows =
            uses.length === 0
              ? sql.literal(noRows)
              : sql`(select coalesce(json_agg(json_build_object('requirement', l.requirement,
                    'id', a.id)), '[]'::json)::text
                  from ${usableAppLinks(sql, [app.id])}
                    and ${sql.in(
                      "l.account",
                      uses.map((use) => use.account.id),
                    )})`;
          const rows = yield* sql`select
            (select count(*)::int from (${access}) access) as access,
            ${users} as accounts, ${linkRows} as "appLinks"`;
          const checked = (yield* Schema.decodeUnknownEffect(Schema.Array(AppRecheck))(rows))[0];
          if (checked === undefined || checked.access !== 1) return yield* new StorageError();
          return passedEvery(
            accounts,
            appUses,
            allowedOf(owned, checked.accounts),
            new Set(
              checked.appLinks
                .filter((row) => uses.some((use) => use.account.id === row.id))
                .map((row) => useKey(row.requirement, row.id)),
            ),
          );
        }).pipe(
          Effect.catchTags({
            SqlError: () => new StorageError(),
            SchemaError: () => new StorageError(),
          }),
        ),
      appsResolving: (owner, apps) =>
        Effect.gen(function* () {
          if (apps.length === 0) return [];
          const user = yield* CurrentUserId;
          const organization = yield* organizationOf(owner);
          const ids = [...new Set(apps.map((app) => app.id))];
          const owned =
            user === undefined ? [] : organizationAccounts(apps.flatMap((app) => app.accounts));
          const usesOf = (app: (typeof apps)[number]) =>
            app.appUses.filter((use) => use.account.owner === owner);
          const used = apps.filter((app) => usesOf(app).length > 0);
          const access =
            user === undefined
              ? sql`select p.id from hosted_app_access p
                  where ${sql.in("p.id", ids)} and p.organization_id = ${organization}`
              : appsUse(sql, { ids, organization, actor: user });
          const users =
            user === undefined || owned.length === 0
              ? sql.literal(noRows)
              : sql`(select coalesce(json_agg(allowed), '[]'::json)::text
                  from (${accountAccess(sql, owned, user)}) allowed)`;
          const linkRows =
            used.length === 0
              ? sql.literal(noRows)
              : sql`(select coalesce(json_agg(json_build_object('app', l.app,
                    'requirement', l.requirement, 'id', a.id)), '[]'::json)::text
                  from ${usableAppLinks(
                    sql,
                    used.map((app) => app.id),
                  )}
                    and ${sql.in("l.account", [
                      ...new Set(used.flatMap((app) => usesOf(app).map((use) => use.account.id))),
                    ])})`;
          const rows = yield* sql`select
            (select coalesce(json_agg(access.id), '[]'::json)::text from (${access}) access)
              as access,
            ${users} as accounts, ${linkRows} as "appLinks"`;
          const checked = (yield* Schema.decodeUnknownEffect(Schema.Array(AppsRecheck))(rows))[0];
          if (checked === undefined) return yield* new StorageError();
          return apps.map((app): Result.Result<ReadonlySet<AccountId>, StorageError> => {
            if (checked.access.filter((id) => id === app.id).length !== 1)
              return Result.fail(new StorageError());
            const uses = usesOf(app);
            return Result.succeed(
              passedEvery(
                app.accounts,
                app.appUses,
                allowedOf(
                  user === undefined ? [] : organizationAccounts(app.accounts),
                  checked.accounts,
                ),
                new Set(
                  checked.appLinks
                    .filter(
                      (row) => row.app === app.id && uses.some((use) => use.account.id === row.id),
                    )
                    .map((row) => useKey(row.requirement, row.id)),
                ),
              ),
            );
          });
        }).pipe(
          Effect.catchTags({
            SqlError: () => new StorageError(),
            SchemaError: () => new StorageError(),
          }),
        ),
      removalResolving: (app, accounts, appUses) =>
        Effect.gen(function* () {
          const user = yield* CurrentUserId;
          const owned = user === undefined ? [] : organizationAccounts(accounts);
          const uses = appUses.filter((use) => use.account.owner === app.owner);
          if (owned.length === 0 && uses.length === 0)
            return passedEvery(accounts, appUses, new Set(), new Set());
          const users =
            user === undefined || owned.length === 0
              ? sql.literal(noRows)
              : sql`(select coalesce(json_agg(allowed), '[]'::json)::text
                  from (${accountAccess(sql, owned, user)}) allowed)`;
          const ours =
            uses.length === 0
              ? sql.literal(noRows)
              : sql`(select coalesce(json_agg(a.id), '[]'::json)::text from executor_accounts a
                  join hosted_account_access p on p.account_id = a.id
                    and a.owner = 'organization:' || p.organization_id
                  where ${sql.in(
                    "a.id",
                    uses.map((use) => use.account.id),
                  )} and a.owner = ${app.owner}
                  and exists(select 1 from member owner_member
                    where owner_member."organizationId" = p.organization_id
                      and owner_member."userId" = p.personal_user_id))`;
          const rows = yield* sql`select ${users} as accounts, ${ours} as ours`;
          const checked = (yield* Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                accounts: AppRecheck.fields.accounts,
                ours: Schema.fromJsonString(Schema.Array(AccountId)),
              }),
            ),
          )(rows))[0];
          if (checked === undefined) return yield* new StorageError();
          const owner = new Set(checked.ours);
          return passedEvery(
            accounts,
            appUses,
            allowedOf(owned, checked.accounts),
            new Set(
              uses
                .filter((use) => owner.has(use.account.id))
                .map((use) => useKey(use.requirement, use.account.id)),
            ),
          );
        }).pipe(
          Effect.catchTags({
            SqlError: () => new StorageError(),
            SchemaError: () => new StorageError(),
          }),
        ),
      accountsResolving: (accounts) =>
        Effect.gen(function* () {
          const user = yield* CurrentUserId;
          if (user === undefined) return yield* new StorageError();
          const owned = organizationAccounts(accounts);
          if (owned.length === 0) return new Set<AccountId>();
          const rows = yield* accountAccess(sql, owned, user);
          return allowedOf(
            owned,
            yield* Schema.decodeUnknownEffect(Schema.Array(AllowedAccount))(rows),
          );
        }).pipe(
          Effect.catchTags({
            SqlError: () => new StorageError(),
            SchemaError: () => new StorageError(),
          }),
        ),
      connectionCompleting: (connection) =>
        Effect.gen(function* () {
          const user = yield* CurrentUserId;
          if (user === undefined) return yield* new StorageError();
          const refused = new AccountConnectionRefused(connection.target);
          const reconnect = connection.reconnectAccount;
          const rows = yield* sql`select c.connection_id from hosted_connection_access c
        join member m on m."organizationId" = c.organization_id and m."userId" = ${user}
        join hosted_app_access a on a.id = (c.target ->> 'app') and a.organization_id = c.organization_id
        where c.connection_id = ${connection.id}
        and c.creator_id = ${user}
        and (c.target ->> 'app') = ${connection.target.app}
        and (c.target ->> 'requirement') = ${connection.target.requirement}
        and (${reconnect}::text is null or exists (
          select 1 from hosted_account_access a where a.account_id = ${reconnect}
          and a.organization_id = c.organization_id
          and a.personal_user_id = ${user}
        )) for share of c, m`;
          if (rows.length === 0) return yield* refused;
        }).pipe(Effect.catchTag("SqlError", () => new StorageError())),
      appCreated: (app) =>
        Effect.gen(function* () {
          const organization = yield* organizationOf(app.owner);
          const intent = yield* AppCreation;
          if (intent.kind === "copy") {
            const copied = yield* sql`insert into hosted_app_access
                (id, organization_id, creator_id, audience)
              select ${app.id}, organization_id, creator_id, audience from hosted_app_access
                where id = ${intent.from} and organization_id = ${organization}
              returning id`;
            if (copied.length === 0) return yield* new StorageError();
            yield* sql`insert into hosted_app_groups (organization_id, app_id, group_id)
              select organization_id, ${app.id}, group_id from hosted_app_groups
                where app_id = ${intent.from}`;
            return;
          }
          const user = yield* CurrentUserId;
          const creator = intent.kind === "system" ? null : yield* member(organization, user);
          yield* sql`insert into hosted_app_access (id, organization_id, creator_id, audience)
        values (${app.id}, ${organization}, ${creator}, ${intent.kind === "member" ? "private" : "everyone"})`;
        }).pipe(Effect.catchTag("SqlError", () => new StorageError())),
      secretsRejected: (input) =>
        Effect.promise(() => import("./managed-executor-key.ts")).pipe(
          Effect.flatMap(({ renewManagedExecutorKey }) =>
            renewManagedExecutorKey(
              executor,
              Effect.sync(() => created.requireVerifiedEmail ?? true),
            )(input),
          ),
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
      accountCreated: (account) =>
        Effect.gen(function* () {
          const organization = yield* organizationOf(account.owner);
          const creation = yield* AccountCreation;
          const user = yield* member(
            organization,
            creation.kind === "attributed" ? creation.user : yield* CurrentUserId,
          );
          yield* sql`insert into hosted_account_access (account_id, organization_id, creator_id, kind, personal_user_id)
          values (${account.id}, ${organization}, ${user}, 'personal', ${user})`;
        }).pipe(Effect.catchTag("SqlError", () => new StorageError())),
      oauthClientCreated: (client) =>
        Effect.gen(function* () {
          const organization = yield* organizationOf(client.owner);
          const intent = yield* OAuthClientCreation;
          const creator =
            intent.kind === "system" ? null : yield* member(organization, yield* CurrentUserId);
          const audience: typeof AppAudience.Type =
            intent.kind === "system" ? { kind: "everyone" } : intent.audience;
          const groups = audience.kind === "groups" ? audience.groups : [];
          yield* requireGroupSharing(sql, organization, creator ?? undefined, groups);
          yield* sql`insert into hosted_oauth_client_access (client_id, organization_id, creator_id, audience)
          values (${client.id}, ${organization}, ${creator}, ${audience.kind})`;
          for (const group of groups)
            yield* sql`insert into hosted_oauth_client_groups (organization_id, client_id, group_id) values (${organization}, ${client.id}, ${group})`;
        }).pipe(
          Effect.catchTags({
            SqlError: () => new StorageError(),
            SchemaError: () => new StorageError(),
            OrganizationForbidden: () => new StorageError(),
          }),
        ),
      oauthClientResolving: (client) =>
        Effect.gen(function* () {
          const user = yield* CurrentUserId;
          if (user === undefined || !client.owner.startsWith("organization:")) return false;
          const organization = client.owner.slice("organization:".length);
          const rows = yield* sql`select p.client_id from hosted_oauth_client_access p
          join member m on m."organizationId" = p.organization_id and m."userId" = ${user}
          where p.client_id = ${client.id} and p.organization_id = ${organization}
          and ((p.audience = 'private' and p.creator_id = ${user}) or p.audience = 'everyone'
            or (p.audience = 'groups' and exists(select 1 from hosted_oauth_client_groups g
              join hosted_group_members gm on gm.group_id = g.group_id
              where g.client_id = p.client_id and gm.member_id = m.id)))`;
          return rows.length === 1;
        }).pipe(Effect.catchTag("SqlError", () => new StorageError())),
      oauthClientsMerging: ({ survivor, merged, apply }) =>
        Effect.gen(function* () {
          const organization = yield* organizationOf(survivor.owner);
          const ids = [survivor.id, ...merged.map((client) => client.id)];
          const rows = yield* sql<{
            readonly client_id: string;
            readonly creator_id: string | null;
            readonly audience: "private" | "groups" | "everyone";
          }>`select client_id, creator_id, audience from hosted_oauth_client_access
          where organization_id = ${organization} and ${sql.in("client_id", ids)}
          order by client_id for update`;
          const groups = (yield* sql<{ readonly group_id: string }>`select distinct group_id
          from hosted_oauth_client_groups
          where organization_id = ${organization} and ${sql.in("client_id", ids)}`).map(
            (row) => row.group_id,
          );
          if (rows.length === 0) return true;
          const privates = new Set(
            rows.filter((row) => row.audience === "private").map((row) => row.creator_id),
          );
          const audience = rows.some((row) => row.audience === "everyone")
            ? ("everyone" as const)
            : privates.size === 0
              ? ("groups" as const)
              : groups.length === 0 && privates.size === 1
                ? ("private" as const)
                : undefined;
          if (audience === undefined) return false;
          if (!apply) return true;
          const own = rows.find((row) => row.client_id === survivor.id);
          const creator =
            audience === "private"
              ? ([...privates][0] ?? null)
              : (own?.creator_id ??
                rows.find((row) => row.creator_id !== null)?.creator_id ??
                null);
          if (own === undefined)
            yield* sql`insert into hosted_oauth_client_access (client_id, organization_id, creator_id, audience)
            values (${survivor.id}, ${organization}, ${creator}, ${audience})`;
          else
            yield* sql`update hosted_oauth_client_access
            set audience = ${audience}, creator_id = ${creator}, revision = gen_random_uuid()::text
            where client_id = ${survivor.id} and organization_id = ${organization}`;
          if (audience === "groups")
            for (const group of groups)
              yield* sql`insert into hosted_oauth_client_groups (organization_id, client_id, group_id)
              values (${organization}, ${survivor.id}, ${group}) on conflict do nothing`;
          else
            yield* sql`delete from hosted_oauth_client_groups
            where organization_id = ${organization} and client_id = ${survivor.id}`;
          return true;
        }).pipe(Effect.catchTag("SqlError", () => new StorageError())),
      accountRemoving: (account) =>
        Effect.gen(function* () {
          const organization = yield* organizationOf(account.owner);
          const user = yield* member(organization, yield* CurrentUserId);
          const policy = yield* sql`select p.account_id from hosted_account_access p
        where p.account_id = ${account.id} and p.organization_id = ${organization}
        and p.personal_user_id = ${user} for update`;
          if (policy.length !== 1) return yield* new StorageError();
          yield* sql`select id from executor_accounts where id = ${account.id} for update`;
          yield* checkContributedAccountRemoval(sql, account.id).pipe(
            Effect.mapError(() => new StorageError()),
          );
          if ((yield* appLinkApps(sql, account.id, true)).length > 0)
            return yield* new StorageError();
          // Unlink the account's user links now, before the SDK removes its webhook sources: link,
          // unlink and app removal all take links before sources, so leaving this to the account
          // row's cascade would take them in the opposite order and deadlock with removing an app
          // that links the account. Deleting the SDK account removes its access policy and grants.
          yield* sql`delete from hosted_app_account_links where account = ${account.id}`;
        }).pipe(Effect.catchTag("SqlError", () => new StorageError())),
      appRemoving: (app) =>
        sql`delete from hosted_app_account_links where app = ${app}`.pipe(
          Effect.asVoid,
          Effect.catchTag("SqlError", () => new StorageError()),
        ),
      appAccountConnected: (input) =>
        Effect.gen(function* () {
          const user = yield* CurrentUserId;
          if (user === undefined) return yield* new StorageError();
          const target = { app: input.app, requirement: input.requirement };
          const organization = yield* organizationOf(input.account.owner);
          // A system-created app has no creator, so the comparison is null; `is true` keeps the
          // selected predicate a boolean.
          const contributed =
            input.scope === "app" && (yield* isContributed(sql, input.app, input.requirement));
          const authority =
            input.scope === "app" && !contributed
              ? sql`(m.role in ('owner','admin') or a.creator_id = m."userId") is true`
              : sql`exists(${appUse(sql, { id: input.app, organization, actor: user })})`;
          const rows = yield* sql`select coalesce(c.target ->> 'scope', 'user') as scope,
            ${authority} as authorized from hosted_connection_access c
            join member m on m."organizationId" = c.organization_id and m."userId" = ${user}
            join hosted_app_access a on a.id = ${input.app} and a.organization_id = c.organization_id
            where c.connection_id = ${input.connection}
            and c.organization_id = ${organization}
            and c.creator_id = ${user}
            and (c.target ->> 'app') = ${input.app}
            and (c.target ->> 'requirement') = ${input.requirement}
            for share of c, m`;
          const started = (yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ scope: AccountScope, authorized: Schema.Boolean })),
          )(rows))[0];
          if (started === undefined) return yield* new AccountConnectionRefused(target);
          if (started.scope !== input.scope)
            return yield* new AccountConnectionTargetChanged(target);
          if (!started.authorized) return yield* new AccountConnectionRefused(target);
          if (input.scope === "app") {
            const owned = organizationAccounts([input.account]);
            const usable =
              owned.length === 0
                ? new Set<AccountId>()
                : allowedOf(
                    owned,
                    yield* Schema.decodeUnknownEffect(Schema.Array(AllowedAccount))(
                      yield* accountAccess(sql, owned, user),
                    ),
                  );
            if (!usable.has(input.account.id)) return yield* new AccountConnectionRefused(target);
          }
          const sources = yield* webhooks;
          yield* addLink(sql, sources, {
            app: input.app,
            requirement: input.requirement,
            account: input.account.id,
            subject: input.scope === "app" ? null : user,
            linkedBy: user,
          }).pipe(Effect.mapError(() => new StorageError()));
        }).pipe(
          Effect.catchTags({
            SqlError: () => new StorageError(),
            SchemaError: () => new StorageError(),
          }),
        ),
    };
    return lifecycle;
  });
  return {
    hooks,
    attach: (instance: Executor, options?: { readonly requireVerifiedEmail?: boolean }) =>
      Effect.sync(() => {
        created.executor = instance;
        created.requireVerifiedEmail = options?.requireVerifiedEmail;
      }),
  };
});
