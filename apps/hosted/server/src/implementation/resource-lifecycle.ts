/** Product metadata commits with SDK resources using the same SQL transaction context. */
import {
  AccountConnectionRefused,
  AccountConnectionTargetChanged,
  AccountId,
  AccountScope,
  StorageError,
  StorageHost,
  type Account,
  type AppId,
  type Executor,
  type ResourceLifecycle,
  type OwnerId,
} from "@executor-js/sdk/core";
import { Context, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { CurrentUserId } from "../contracts/auth.ts";
import { OrganizationId } from "../contracts/organization.ts";
import { ConnectionDestination, type AppAudience } from "../contracts/resource-access.ts";
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
  | { readonly kind: "shared" }
  | { readonly kind: "system" }
  | { readonly kind: "copy"; readonly from: AppId };
const AppCreation = Context.Reference<AppCreation>("hosted/AppCreation", {
  defaultValue: () => ({ kind: "member" }),
});
type AccountCreation =
  | typeof ConnectionDestination.Type
  | { readonly kind: "attributed-personal"; readonly user: string };
const AccountCreation = Context.Reference<AccountCreation>("hosted/AccountCreation", {
  defaultValue: () => ({ kind: "personal" }),
});
/**
 * A copy a data step makes of `from`, such as for a profile with other accounts, is shared exactly
 * as `from` is: the same creator, audience and groups.
 */
export const copiedAppCreation =
  (from: AppId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(AppCreation, { kind: "copy", from }));
/** Only the explicit system installer may create an unattributed organization app. */
export const organizationAppCreation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AppCreation, { kind: "system" }));
/**
 * An app a member creates for everyone in the organization: the member is its creator and its
 * audience is everyone, such as an integration the v1 import moves for the organization's owner.
 */
export const sharedAppCreation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AppCreation, { kind: "shared" }));
/** Connection completion uses the persisted destination, not callback query parameters. */
export const accountDestination =
  (destination: typeof ConnectionDestination.Type) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(AccountCreation, destination));
/** Managed per-user credentials have a known owner even when provisioned by a system installer. */
export const personalAccountCreation =
  (user: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(AccountCreation, { kind: "attributed-personal", user }));

/**
 * Who may use a stored OAuth client: the audience an administrator chose when registering it, or
 * everyone for a client Executor registered automatically or a data step moved, which has no
 * creator.
 */
type OAuthClientCreation =
  | { readonly kind: "member"; readonly audience: typeof AppAudience.Type }
  | { readonly kind: "system" };
const OAuthClientCreation = Context.Reference<OAuthClientCreation>("hosted/OAuthClientCreation", {
  defaultValue: () => ({ kind: "system" }),
});
/** The audience is recorded with the client's access record, in the client's transaction. */
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

/** The rows that let a subject use an app now, as a member: exactly one when they may. */
const appUse = (
  sql: SqlClient.SqlClient,
  input: { readonly id: AppId; readonly organization: OrganizationId; readonly actor: string },
) => sql`select p.id from hosted_app_access p join member m
      on m."organizationId" = p.organization_id and m."userId" = ${input.actor}
      where p.id = ${input.id} and p.organization_id = ${input.organization}
      and ((p.audience = 'private' and p.creator_id = m."userId") or p.audience = 'everyone'
        or (p.audience = 'groups' and exists(select 1 from hosted_app_groups g
          join hosted_group_members gm on gm.group_id = g.group_id
          where g.app_id = p.id and gm.member_id = m.id)))`;

/** Whether a subject is a member who may use the app now, as any of its operations requires. */
export const actorUsesApp = (
  sql: SqlClient.SqlClient,
  input: { readonly id: AppId; readonly owner: OwnerId; readonly actor: string },
) =>
  Effect.gen(function* () {
    const organization = yield* organizationOf(input.owner);
    const rows = yield* appUse(sql, { ...input, organization });
    return rows.length === 1;
  }).pipe(Effect.catchTag("SqlError", () => new StorageError()));

/** What the account checks read of an account: its ID and the owner the SDK resolved it under. */
type AccountOwner = Pick<Account, "id" | "owner">;
// An account outside an organization is never authorized; it is refused in its turn.
const organizationAccounts = <A extends AccountOwner>(accounts: readonly A[]) =>
  accounts.filter(
    (account) =>
      account.owner.startsWith("organization:") &&
      Schema.is(OrganizationId)(account.owner.slice("organization:".length)),
  );
/** The accounts whose policy still lets the user use them, with the owner each belongs to. */
const accountAccess = (sql: SqlClient.SqlClient, accounts: readonly AccountOwner[], user: string) =>
  sql`select p.account_id as id, 'organization:' || p.organization_id as owner
        from hosted_account_access p
        where ${sql.in(
          "p.account_id",
          accounts.map((account) => account.id),
        )}
        and (p.kind <> 'personal' or exists(select 1 from member owner_member
          where owner_member."organizationId" = p.organization_id and owner_member."userId" = p.personal_user_id))
        and exists(select 1 from member m
          where m."organizationId" = p.organization_id and m."userId" = ${user}
          and ((p.kind = 'personal' and p.personal_user_id = m."userId")
            or (p.kind = 'shared' and (p.audience = 'everyone' or exists(
              select 1 from hosted_account_groups g join hosted_group_members gm on gm.group_id = g.group_id
              where g.account_id = p.account_id and gm.member_id = m.id)))))`;
const AllowedAccount = Schema.Struct({ id: AccountId, owner: Schema.String });
type AllowedAccount = typeof AllowedAccount.Type;
const AllowedUse = Schema.Struct({ requirement: Schema.String, id: AccountId });
const AppRecheck = Schema.Struct({
  access: Schema.Number,
  accounts: Schema.fromJsonString(Schema.Array(AllowedAccount)),
  appLinks: Schema.fromJsonString(Schema.Array(AllowedUse)),
});
// Each account must still belong to the owner the invocation resolved it under.
const allowedOf = (accounts: readonly AccountOwner[], allowed: ReadonlyArray<AllowedAccount>) => {
  const owners = new Map(accounts.map((account) => [account.id, account.owner]));
  return new Set(allowed.filter((row) => owners.get(row.id) === row.owner).map((row) => row.id));
};
/** An app requirement's account, as the SDK asks it to be checked. */
type AppUse = Parameters<ResourceLifecycle["appResolving"]>[2][number];
const useKey = (requirement: string, account: AccountId) => JSON.stringify([requirement, account]);
/**
 * The accounts that passed every check asked of them: each user account by `users`, and each of an
 * account's app requirements by `uses`. An account in both lists must pass both.
 */
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
/** An empty JSON list, for a check with nothing to read. */
const noRows = "'[]'::text";

/**
 * Capture the host client, not a transaction or actor; both resolve on each resource write.
 * Hooks link webhook sources through the executor they belong to, in its tracked transaction
 * when called outside one, so they read it only once it exists. Pass the result to
 * `createExecutor` as `hooks`, then hand the created executor to `attach`.
 */
export const hostedResourceLifecycle = Effect.gen(function* () {
  const created: { executor?: Executor } = {};
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
      // Called outside resource transactions; the handover serializes with link and unlink. The
      // source's new actor or its removal is saved intent; reconcile it once committed. A caller
      // that supplies a wake gets it; background resolution leaves it to the next poll.
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
      // The actor must be a member who may use the app now: a member removed from the app's
      // groups stops running it, including schedules, webhook callbacks and workflow steps. The
      // actor's use of its user accounts, and each app requirement's app link, are rechecked in
      // the same statement. App-scope work has no actor: the app must still be its organization's, and
      // it has no user accounts.
      appResolving: (app, accounts, appUses) =>
        Effect.gen(function* () {
          const user = yield* CurrentUserId;
          const organization = yield* organizationOf(app.owner);
          // The SDK resolved each account with its owner; only the product's policy is checked here.
          const owned = user === undefined ? [] : organizationAccounts(accounts);
          // An app account is the app owner's; one resolved under another owner is refused.
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
      // Removing what the app registered needs no app access. User accounts are checked by the
      // registration's actor's use; an app-account registration has none. An app account passes
      // when the app could still use it if linked: it belongs to the app's organization under a
      // valid access record and, if personal, its owner is still a member. No current app link is
      // required, since unlinking is what removes its registrations. A departed member's personal
      // account is refused, as resolving it is, and its registrations wait for manual removal.
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
                  and (p.kind <> 'personal' or exists(select 1 from member owner_member
                    where owner_member."organizationId" = p.organization_id
                      and owner_member."userId" = p.personal_user_id)))`;
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
          // The SDK resolved each account with its owner; only the product's policy is checked here.
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
          // The SDK supplies the connection's reconnect target and the app requirement it links
          // to, so the product checks its own access rows only. Whether the requirement's scope
          // lets this member complete it is checked by `appAccountConnected`, under the app's
          // lock, against the version the SDK completes against. A member who lost the access
          // the connection needs, such as management of the account it reconnects, is refused.
          const refused = new AccountConnectionRefused(connection.target);
          const reconnect = connection.reconnectAccount;
          const rows =
            yield* sql`select c.connection_id, c.organization_id as organization, c.destination from hosted_connection_access c
        join member m on m."organizationId" = c.organization_id and m."userId" = ${user}
        join hosted_app_access a on a.id = (c.target ->> 'app') and a.organization_id = c.organization_id
        where c.connection_id = ${connection.id}
        and c.creator_id = ${user}
        and (c.target ->> 'app') = ${connection.target.app}
        and (c.target ->> 'requirement') = ${connection.target.requirement}
        and (${reconnect}::text is null or exists (
          select 1 from hosted_account_access a where a.account_id = ${reconnect}
          and a.organization_id = c.organization_id
          and ((a.kind = 'personal' and a.personal_user_id = ${user})
            or (a.kind = 'shared' and (a.creator_id = ${user} or m.role in ('owner','admin'))))
        )) for share of c, m`;
          const intent = (yield* Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({ organization: OrganizationId, destination: ConnectionDestination }),
            ),
          )(rows))[0];
          if (intent === undefined) return yield* refused;
          if (intent.destination.kind === "shared" && intent.destination.audience.kind === "groups")
            yield* requireGroupSharing(
              sql,
              intent.organization,
              user,
              intent.destination.audience.groups,
            ).pipe(Effect.catchTag("OrganizationForbidden", () => refused));
        }).pipe(
          Effect.catchTags({
            SqlError: () => new StorageError(),
            SchemaError: () => new StorageError(),
          }),
        ),
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
      accountIdentityPlacement: (account) =>
        Effect.gen(function* () {
          const rows = yield* sql`select organization_id, kind, personal_user_id, audience
          from hosted_account_access where account_id = ${account.id}`;
          const row = rows[0];
          if (row === undefined) return null;
          const groups = yield* sql`select group_id from hosted_account_groups
          where account_id = ${account.id} order by group_id`;
          return JSON.stringify([
            row.organization_id,
            row.kind,
            row.personal_user_id ?? null,
            row.audience ?? null,
            groups.map((group) => group.group_id),
          ]);
        }).pipe(Effect.catchTag("SqlError", () => new StorageError())),
      connectionIdentityPlacement: (connection) =>
        Effect.gen(function* () {
          const rows =
            yield* sql`select organization_id as organization, creator_id as creator, destination
          from hosted_connection_access where connection_id = ${connection.id}`;
          const row = (yield* Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                organization: OrganizationId,
                creator: Schema.String,
                destination: ConnectionDestination,
              }),
            ),
          )(rows))[0];
          if (row === undefined) return null;
          const destination = row.destination;
          return JSON.stringify(
            destination.kind === "personal"
              ? [row.organization, "personal", row.creator, null, []]
              : [
                  row.organization,
                  "shared",
                  null,
                  destination.audience.kind,
                  destination.audience.kind === "groups"
                    ? [...destination.audience.groups].sort()
                    : [],
                ],
          );
        }).pipe(
          Effect.catchTags({
            SqlError: () => new StorageError(),
            SchemaError: () => new StorageError(),
          }),
        ),
      accountCreated: (account) =>
        Effect.gen(function* () {
          const organization = yield* organizationOf(account.owner);
          const destination = yield* AccountCreation;
          const user = yield* member(
            organization,
            destination.kind === "attributed-personal" ? destination.user : yield* CurrentUserId,
          );
          if (destination.kind !== "shared") {
            yield* sql`insert into hosted_account_access (account_id, organization_id, creator_id, kind, personal_user_id)
          values (${account.id}, ${organization}, ${user}, 'personal', ${user})`;
            return;
          }
          const groups = destination.audience.kind === "groups" ? destination.audience.groups : [];
          yield* requireGroupSharing(sql, organization, user, groups);
          yield* sql`insert into hosted_account_access (account_id, organization_id, creator_id, kind, audience)
        values (${account.id}, ${organization}, ${user}, 'shared', ${destination.audience.kind})`;
          for (const group of groups)
            yield* sql`insert into hosted_account_groups (organization_id, account_id, group_id) values (${organization}, ${account.id}, ${group})`;
        }).pipe(
          Effect.catchTags({
            SqlError: () => new StorageError(),
            SchemaError: () => new StorageError(),
            OrganizationForbidden: () => new StorageError(),
          }),
        ),
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
      // Whichever way a sign-in resolved the client, the caller must be in its audience now. A client
      // without an access record, or a caller who is no longer a member, is refused.
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
      // Clients one owner held the same credentials in for one server become one. Whoever could use
      // any of them may use the survivor: the union of their audiences, when one audience says it.
      // Everyone, if any was everyone's; otherwise the union of their groups; otherwise one person's
      // private client. A private client with groups, or two people's private clients, cannot be
      // one audience without widening or narrowing who may use it, so the step leaves them.
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
          // Clients without a record are usable by nobody, so they add nobody.
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
        and ((p.kind = 'personal' and p.personal_user_id = ${user}) or (p.kind = 'shared' and (p.creator_id = ${user}
          or exists(select 1 from member m where m."organizationId" = ${organization} and m."userId" = ${user} and m.role in ('owner','admin'))))) for update`;
          if (policy.length !== 1) return yield* new StorageError();
          // An app uses an app link for every caller: it must be unlinked first. The route refuses
          // with the apps that link it; this refuses an app link made since. The access row's lock
          // above makes a concurrent link wait: inserting a link takes a key share lock on the
          // account row, which deleting the account then holds exclusively.
          yield* sql`select id from executor_accounts where id = ${account.id} for update`;
          if ((yield* appLinkApps(sql, account.id)).length > 0) return yield* new StorageError();
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
      // An account connected for a user requirement is linked for its connecting member; one for
      // an app requirement is linked for everyone. This runs under the app's lock, with the scope the
      // active version gives the requirement now; `connectionCompleting` ran before the lock,
      // so a version activated since may have changed it. The connection must have been
      // started for this scope, or its target changed; and by its completing member, who for a
      // user requirement may use the app, and for an app requirement manages the app and may use
      // the account, now that the account's access record exists. Otherwise the member is refused.
      // Managing an account is not using it.
      appAccountConnected: (input) =>
        Effect.gen(function* () {
          const user = yield* CurrentUserId;
          if (user === undefined) return yield* new StorageError();
          const target = { app: input.app, requirement: input.requirement };
          const organization = yield* organizationOf(input.account.owner);
          // A system-created app has no creator, so the comparison is null; `is true` keeps the
          // selected predicate a boolean.
          const authority =
            input.scope === "app"
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
    /** Let the hooks reach the executor they were created for. */
    attach: (instance: Executor) =>
      Effect.sync(() => {
        created.executor = instance;
      }),
  };
});
