/** Product metadata commits with SDK resources using the same SQL transaction context. */
import {
  AccountId,
  CurrentProfile,
  StorageError,
  type Account,
  type Profile,
  type ResourceLifecycle,
  type OwnerId,
} from "@executor-js/sdk/core";
import { Context, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { CurrentUserId } from "../contracts/auth.ts";
import { OrganizationId } from "../contracts/organization.ts";
import { ConnectionDestination } from "../contracts/resource-access.ts";

import { requireGroupSharing } from "./group-sharing.ts";

type AppCreation = { readonly kind: "member" } | { readonly kind: "system" };
const AppCreation = Context.Reference<AppCreation>("hosted/AppCreation", {
  defaultValue: () => ({ kind: "member" }),
});
type AccountCreation =
  | typeof ConnectionDestination.Type
  | { readonly kind: "attributed-personal"; readonly user: string };
const AccountCreation = Context.Reference<AccountCreation>("hosted/AccountCreation", {
  defaultValue: () => ({ kind: "personal" }),
});
/** Only the explicit system installer may create an unattributed organization app. */
export const organizationAppCreation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AppCreation, { kind: "system" }));
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

const organizationOf = (owner: OwnerId) =>
  owner.startsWith("organization:")
    ? Schema.decodeUnknownEffect(OrganizationId)(owner.slice("organization:".length)).pipe(
        Effect.mapError(() => new StorageError()),
      )
    : Effect.fail(new StorageError());

const AllowedAccount = Schema.Struct({ id: AccountId, owner: Schema.String });
type AllowedAccount = typeof AllowedAccount.Type;
const ProfileRecheck = Schema.Struct({
  access: Schema.Number,
  accounts: Schema.fromJsonString(Schema.Array(AllowedAccount)),
});

/** Capture the host client, not a transaction or actor; both resolve on each resource write. */
export const hostedResourceLifecycle = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const member = (organization: OrganizationId, user: string | undefined) =>
    Effect.gen(function* () {
      if (user === undefined) return yield* new StorageError();
      const rows =
        yield* sql`select id from member where "organizationId" = ${organization} and "userId" = ${user} for share`;
      if (rows.length !== 1) return yield* new StorageError();
      return user;
    });
  /** The subject may still run the profile's app: exactly one row. */
  const profileAccess = (profile: Profile, organization: OrganizationId) =>
    sql`select p.id from hosted_app_access p join member m
        on m."organizationId" = p.organization_id and m."userId" = ${profile.subject}
        where p.id = ${profile.app} and p.organization_id = ${organization}
        and ((p.audience = 'private' and p.creator_id = m."userId") or p.audience = 'everyone'
          or (p.audience = 'groups' and exists(select 1 from hosted_app_groups g
            join hosted_group_members gm on gm.group_id = g.group_id
            where g.app_id = p.id and gm.member_id = m.id)))`;
  // An account outside an organization is never authorized; it is refused in its turn.
  const organizationAccounts = (accounts: readonly Account[]) =>
    accounts.filter(
      (account) =>
        account.owner.startsWith("organization:") &&
        Schema.is(OrganizationId)(account.owner.slice("organization:".length)),
    );
  /** The accounts whose policy still lets the user use them, with the owner each belongs to. */
  const accountAccess = (accounts: readonly Account[], user: string) =>
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
  // Each account must still belong to the owner the invocation resolved it under.
  const allowedOf = (accounts: readonly Account[], allowed: ReadonlyArray<AllowedAccount>) => {
    const owners = new Map(accounts.map((account) => [account.id, account.owner]));
    return new Set(allowed.filter((row) => owners.get(row.id) === row.owner).map((row) => row.id));
  };
  const lifecycle: ResourceLifecycle = {
    profileResolving: (profile, accounts) =>
      Effect.gen(function* () {
        const organization = yield* organizationOf(profile.owner);
        const caller = yield* CurrentUserId;
        if (caller !== undefined && caller !== profile.subject) return yield* new StorageError();
        // The SDK resolved each account with its owner; only the product's policy is checked here.
        const owned = organizationAccounts(accounts);
        const rows = yield* sql`select
          (select count(*)::int from (${profileAccess(profile, organization)}) access) as access,
          (select coalesce(json_agg(allowed), '[]'::json)::text
            from (${accountAccess(owned, profile.subject)}) allowed) as accounts`;
        const checked = (yield* Schema.decodeUnknownEffect(Schema.Array(ProfileRecheck))(rows))[0];
        if (checked === undefined || checked.access !== 1) return yield* new StorageError();
        return allowedOf(owned, checked.accounts);
      }).pipe(
        Effect.catchTags({
          SqlError: () => new StorageError(),
          SchemaError: () => new StorageError(),
        }),
      ),
    accountsResolving: (accounts) =>
      Effect.gen(function* () {
        const profile = yield* CurrentProfile;
        const user = profile === undefined ? yield* CurrentUserId : profile.subject;
        if (user === undefined) return yield* new StorageError();
        const owned = organizationAccounts(accounts);
        if (owned.length === 0) return new Set<AccountId>();
        // The SDK resolved each account with its owner; only the product's policy is checked here.
        const rows = yield* accountAccess(owned, user);
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
        // The SDK supplies the connection's reconnect target and the profile it targets, so the
        // product checks its own access rows only. A targeted profile must be the caller's own,
        // enabled, and not on its way out.
        const target = connection.target;
        if (
          target !== null &&
          (target.profile.subject !== user ||
            !target.profile.enabled ||
            target.profile.status === "removing" ||
            target.profile.status === "removed")
        )
          return yield* new StorageError();
        const targetApp = target === null ? null : target.app;
        const targetProfile = target === null ? null : target.profile.id;
        const reconnect = connection.reconnectAccount;
        const rows =
          yield* sql`select c.connection_id, c.organization_id as organization, c.destination from hosted_connection_access c
        join member m on m."organizationId" = c.organization_id and m."userId" = ${user}
        where c.connection_id = ${connection.id}
        and c.creator_id = ${user}
        and (c.target is null or (
          (c.target ->> 'app') = ${targetApp} and (c.target ->> 'installation') = ${targetProfile}
          and exists (
            select 1 from hosted_app_access a
            where a.id = (c.target ->> 'app') and a.organization_id = c.organization_id
            and ((a.audience = 'private' and a.creator_id = ${user}) or a.audience = 'everyone'
              or (a.audience = 'groups' and exists(select 1 from hosted_app_groups g join hosted_group_members gm on gm.group_id = g.group_id where g.app_id = a.id and gm.member_id = m.id)))
          )
        ))
        and (${reconnect}::text is null or exists (
          select 1 from hosted_account_access a where a.account_id = ${reconnect}
          and a.organization_id = c.organization_id
          and ((a.kind = 'personal' and a.personal_user_id = ${user})
            or (a.kind = 'shared' and (a.creator_id = ${user} or m.role in ('owner','admin'))))
        )) for share of c, m`;
        if (rows.length !== 1) return yield* new StorageError();
        const intent = (yield* Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({ organization: OrganizationId, destination: ConnectionDestination }),
          ),
        )(rows))[0];
        if (intent === undefined) return yield* new StorageError();
        if (intent.destination.kind === "shared" && intent.destination.audience.kind === "groups")
          yield* requireGroupSharing(
            sql,
            intent.organization,
            user,
            intent.destination.audience.groups,
          );
      }).pipe(
        Effect.catchTags({
          SqlError: () => new StorageError(),
          SchemaError: () => new StorageError(),
          OrganizationForbidden: () => new StorageError(),
        }),
      ),
    appCreated: (app) =>
      Effect.gen(function* () {
        const organization = yield* organizationOf(app.owner);
        const intent = yield* AppCreation;
        const user = yield* CurrentUserId;
        const creator = intent.kind === "system" ? null : yield* member(organization, user);
        yield* sql`insert into hosted_app_access (id, organization_id, creator_id, audience)
        values (${app.id}, ${organization}, ${creator}, ${intent.kind === "system" ? "everyone" : "private"})`;
      }).pipe(Effect.catchTag("SqlError", () => new StorageError())),
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
    accountRemoving: (account) =>
      Effect.gen(function* () {
        const organization = yield* organizationOf(account.owner);
        const user = yield* member(organization, yield* CurrentUserId);
        const policy = yield* sql`select p.account_id from hosted_account_access p
        where p.account_id = ${account.id} and p.organization_id = ${organization}
        and ((p.kind = 'personal' and p.personal_user_id = ${user}) or (p.kind = 'shared' and (p.creator_id = ${user}
          or exists(select 1 from member m where m."organizationId" = ${organization} and m."userId" = ${user} and m.role in ('owner','admin'))))) for update`;
        if (policy.length !== 1) return yield* new StorageError();
        // The SDK clears profile selections itself when the product removes with `bindings: "clear"`.
        // Deleting the SDK account cascades through its access policy and group grants.
      }).pipe(Effect.catchTag("SqlError", () => new StorageError())),
  };
  return lifecycle;
});
