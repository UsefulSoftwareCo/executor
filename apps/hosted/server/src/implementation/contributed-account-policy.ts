/** App authors opt in to member contributions; ordinary app requirements need management. */
import { AccountId, AppId, StorageError, type AccountScope } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { CurrentUserId } from "../contracts/auth.ts";
import { OrganizationForbidden, type OrganizationId } from "../contracts/organization.ts";
import {
  applicationAccess,
  currentResourceAuthority,
  policyDatabase,
  requireAppAccessAs,
  type ResourceAuthority,
} from "./resource-policy.ts";

/** Read the active deployment again under the link lock. Existing requirements opt out. */
export const isContributed = (sql: SqlClient.SqlClient, app: AppId, requirement: string) =>
  sql`select 1 from executor_apps a
    join executor_deployments d on d.id = a.active_deployment
    where a.id = ${app}
      and d.requirements::jsonb -> 'accounts' -> ${requirement} ->> 'scope' = 'app'
      and d.requirements::jsonb -> 'accounts' -> ${requirement} ->> 'cardinality' = 'many'
      and d.requirements::jsonb -> 'accounts' -> ${requirement} ->> 'contributed' = 'true'`.pipe(
    Effect.map((rows) => rows.length === 1),
    Effect.catchTag("SqlError", () => new StorageError()),
  );

export const requireRequirementAccessAs = (
  actor: ResourceAuthority,
  input: { readonly app: AppId; readonly requirement: string; readonly scope: AccountScope },
) =>
  Effect.gen(function* () {
    const contributed =
      input.scope === "app" &&
      (yield* isContributed(yield* policyDatabase, input.app, input.requirement));
    return yield* requireAppAccessAs(
      actor,
      input.app,
      input.scope === "user" || contributed ? "use" : "manage",
    );
  });

export const requireRequirementAccess = (input: Parameters<typeof requireRequirementAccessAs>[1]) =>
  Effect.flatMap(currentResourceAuthority, (actor) => requireRequirementAccessAs(actor, input));

/** Under the app's link lock, the linker or an editor can remove a contributed link. */
export const requireLinkRemovalAs = (
  sql: SqlClient.SqlClient,
  actor: ResourceAuthority,
  input: { readonly app: AppId; readonly requirement: string; readonly account: AccountId },
) =>
  Effect.gen(function* () {
    const access = yield* applicationAccess(input.app, actor);
    if (access.canManage) return;
    if (yield* isContributed(sql, input.app, input.requirement)) {
      const own = yield* sql`select 1 from hosted_app_account_links
        where app = ${input.app} and requirement = ${input.requirement}
          and account = ${input.account} and subject is null and linked_by = ${actor.user}`;
      if (own.length === 1) return;
    }
    return yield* new OrganizationForbidden();
  }).pipe(Effect.catchTag("SqlError", () => new StorageError()));

const Contribution = Schema.Struct({ app: AppId, requirement: Schema.String, account: AccountId });

/** Deleting saved credentials must pass the same checks as removing each contributed link. */
export const checkContributedAccountRemoval = (sql: SqlClient.SqlClient, account: AccountId) =>
  Effect.gen(function* () {
    const links = yield* Schema.decodeUnknownEffect(Schema.Array(Contribution))(
      yield* sql`select l.app, l.requirement, l.account from hosted_app_account_links l
        join executor_apps a on a.id = l.app
        join executor_deployments d on d.id = a.active_deployment
        where l.account = ${account} and l.subject is null
          and d.requirements::jsonb -> 'accounts' -> l.requirement ->> 'scope' = 'app'
          and d.requirements::jsonb -> 'accounts' -> l.requirement ->> 'contributed' = 'true'
        order by l.app, l.requirement`,
    );
    if (links.length === 0) return;
    // The SDK already holds the account row. Fail contention rather than deadlocking with a
    // link writer holding the app row while waiting for this account.
    for (const link of links)
      yield* sql`select id from executor_apps where id = ${link.app} for no key update nowait`;
    const user = yield* CurrentUserId;
    for (const link of links) {
      const permitted = yield* sql`select m.id from member m
        join hosted_account_access p on p.organization_id = m."organizationId" and p.account_id = ${account}
        join hosted_app_access a on a.organization_id = m."organizationId" and a.id = ${link.app}
        where m."userId" = ${user ?? ""} and (m.role in ('owner', 'admin') or a.creator_id = m."userId"
          or exists (select 1 from hosted_app_account_links l where l.app = ${link.app}
            and l.requirement = ${link.requirement} and l.account = ${account}
            and l.subject is null and l.linked_by = m."userId")) for share of m`;
      if (permitted.length !== 1) return yield* new OrganizationForbidden();
    }
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );

/** Sharing an account for use does not make another member its holder. */
export const accountHolders = (
  sql: SqlClient.SqlClient,
  organization: OrganizationId,
  accounts: readonly AccountId[],
) =>
  accounts.length === 0
    ? Effect.succeed([])
    : sql`select account_id as account, coalesce(personal_user_id, creator_id) as holder
        from hosted_account_access
        where organization_id = ${organization} and ${sql.in("account_id", accounts)}`.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({ account: AccountId, holder: Schema.NullOr(Schema.String) }),
            ),
          ),
        ),
        Effect.mapError(() => new StorageError()),
      );
