/** Product metadata commits with SDK resources using the same SQL transaction context. */
import {
  CurrentProfile,
  StorageError,
  type ResourceLifecycle,
  type OwnerId,
} from "@executor-js/sdk/core";
import { Context, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
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
  const lifecycle: ResourceLifecycle = {
    profileResolving: (profile) =>
      Effect.gen(function* () {
        const organization = yield* organizationOf(profile.owner);
        const caller = yield* CurrentUserId;
        if (caller !== undefined && caller !== profile.subject) return yield* new StorageError();
        const rows = yield* sql`select p.id from hosted_app_access p join member m
        on m."organizationId" = p.organization_id and m."userId" = ${profile.subject}
        where p.id = ${profile.app} and p.organization_id = ${organization}
        and ((p.audience = 'private' and p.creator_id = m."userId") or p.audience = 'everyone'
          or (p.audience = 'groups' and exists(select 1 from hosted_app_groups g
            join hosted_group_members gm on gm.group_id = g.group_id
            where g.app_id = p.id and gm.member_id = m.id)))`;
        if (rows.length !== 1) return yield* new StorageError();
      }).pipe(Effect.catchTag("SqlError", () => new StorageError())),
    accountResolving: (account) =>
      Effect.gen(function* () {
        const organization = yield* organizationOf(account.owner);
        const profile = yield* CurrentProfile;
        const user = profile === undefined ? yield* CurrentUserId : profile.subject;
        if (user === undefined) return yield* new StorageError();
        const rows = yield* sql`select p.account_id from hosted_account_access p
        join executor_accounts a on a.id = p.account_id and a.owner = ${account.owner}
        where p.account_id = ${account.id} and p.organization_id = ${organization}
        and (p.kind <> 'personal' or exists(select 1 from member owner_member
          where owner_member."organizationId" = p.organization_id and owner_member."userId" = p.personal_user_id))
        and exists(select 1 from member m
          where m."organizationId" = p.organization_id and m."userId" = ${user}
          and ((p.kind = 'personal' and p.personal_user_id = m."userId")
            or (p.kind = 'shared' and (p.audience = 'everyone' or exists(
              select 1 from hosted_account_groups g join hosted_group_members gm on gm.group_id = g.group_id
              where g.account_id = p.account_id and gm.member_id = m.id)))))`;
        if (rows.length !== 1) return yield* new StorageError();
      }).pipe(Effect.catchTag("SqlError", () => new StorageError())),
    connectionCompleting: (connection) =>
      Effect.gen(function* () {
        const user = yield* CurrentUserId;
        if (user === undefined) return yield* new StorageError();
        const rows =
          yield* sql`select c.connection_id, c.organization_id as organization, c.destination from hosted_connection_access c
        join executor_account_connections request on request.id = c.connection_id
        join member m on m."organizationId" = c.organization_id and m."userId" = ${user}
        where c.connection_id = ${connection}
        and c.creator_id = ${user}
        and (c.target is null or exists (
          select 1 from hosted_app_access a
          where a.id = (c.target ->> 'app') and a.organization_id = c.organization_id
          and exists(select 1 from executor_installations i where i.id = (c.target ->> 'installation') and i.app = a.id and i.subject = ${user} and i.enabled and i.status not in ('removing', 'removed'))
          and ((a.audience = 'private' and a.creator_id = ${user}) or a.audience = 'everyone'
            or (a.audience = 'groups' and exists(select 1 from hosted_app_groups g join hosted_group_members gm on gm.group_id = g.group_id where g.app_id = a.id and gm.member_id = m.id)))
        ))
        and (request.reconnect_account is null or exists (
          select 1 from hosted_account_access a where a.account_id = request.reconnect_account
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
        // Match the SDK's app lock before editing any of its profiles.
        yield* sql`select id from executor_apps a where owner = ${account.owner} and
          exists(select 1 from executor_installations i, jsonb_each(i.accounts::jsonb) binding where i.app = a.id and (binding.value = to_jsonb(${account.id}::text) or binding.value @> jsonb_build_array(${account.id}::text)))
          order by id for update`;
        yield* sql`update executor_installations a set revision = revision + 1,
        status = case when status in ('removed', 'removing') then status else 'pending' end, failure = null, accounts = (
        select coalesce(jsonb_object_agg(binding.key,
          case when jsonb_typeof(binding.value) = 'array' then (
            select coalesce(jsonb_agg(value), '[]'::jsonb) from jsonb_array_elements(binding.value) value where value <> to_jsonb(${account.id}::text)
          ) else binding.value end), '{}'::jsonb)
        from jsonb_each(a.accounts::jsonb) binding
        where binding.value <> to_jsonb(${account.id}::text)
          and not (jsonb_typeof(binding.value) = 'array'
            and binding.value @> jsonb_build_array(${account.id}::text)
            and binding.value <@ jsonb_build_array(${account.id}::text))
      ) where a.owner = ${account.owner} and exists(select 1 from jsonb_each(accounts::jsonb) binding where binding.value = to_jsonb(${account.id}::text) or binding.value @> jsonb_build_array(${account.id}::text))`;
        // Deleting the SDK account cascades through its access policy and group grants.
      }).pipe(Effect.catchTag("SqlError", () => new StorageError())),
  };
  return lifecycle;
});
