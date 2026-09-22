/** Product metadata commits with SDK resources using the same SQL transaction context. */
import { StorageError, type ResourceLifecycle, type OwnerId } from "@executor-js/sdk/core";
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
    accountResolving: (account) =>
      Effect.gen(function* () {
        const organization = yield* organizationOf(account.owner);
        const user = yield* CurrentUserId;
        // Userless calls are existing host-owned webhook/workflow dispatch, with fixed bindings.
        // They do not inherit a visitor identity or acquire a replacement credential.
        const rows = yield* sql`select p.account_id from hosted_account_access p
        join executor_accounts a on a.id = p.account_id and a.owner = ${account.owner}
        where p.account_id = ${account.id} and p.organization_id = ${organization}
        and (p.kind <> 'personal' or exists(select 1 from member owner_member
          where owner_member."organizationId" = p.organization_id and owner_member."userId" = p.personal_user_id))
        and (${user ?? null}::text is null or exists(select 1 from member m
          where m."organizationId" = p.organization_id and m."userId" = ${user ?? null}
          and ((p.kind = 'personal' and p.personal_user_id = m."userId")
            or (p.kind = 'shared' and (p.audience = 'everyone' or exists(
              select 1 from hosted_account_groups g join hosted_group_members gm on gm.group_id = g.group_id
              where g.account_id = p.account_id and gm.member_id = m.id))))))`;
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
          and (a.creator_id = ${user} or m.role in ('owner','admin'))
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
        // Lock each affected app before changing its selection, matching the SDK's writer lock.
        yield* sql`select id from executor_apps where owner = ${account.owner} and exists(select 1 from jsonb_each(accounts::jsonb) binding where binding.value = to_jsonb(${account.id}::text) or binding.value @> jsonb_build_array(${account.id}::text)) order by id for update`;
        yield* sql`update executor_apps a set accounts = (
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
