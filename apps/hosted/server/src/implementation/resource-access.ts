import { CurrentAuthorization } from "../contracts/authorization.ts";
import { permittedAppIds } from "@executor-js/authorization";
import { AccountGrants } from "./proofs/account-access.ts";
/** Sharing writes are atomic; metadata visibility and credential use remain separate. */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { teamAppPending } from "./provisioning.ts";
import { HttpApiBuilder } from "effect/http-api";
import { StorageError, type AppId, type Provider, type ProviderId } from "@executor-js/sdk/core";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { CurrentOrganization, OrganizationForbidden } from "../contracts/organization.ts";
import {
  AccessConflict,
  type AppAudience,
  type SharedAudience,
  type AccessRevision,
} from "../contracts/resource-access.ts";
import { requireGroupSharing } from "./group-sharing.ts";
import {
  policyDatabase,
  currentResourceAuthority,
  applicationAccesses,
  accountAccesses,
  requireAppAccess,
  requireAccountAccess,
} from "./resource-policy.ts";

const lockActor = Effect.gen(function* () {
  const actor = yield* currentResourceAuthority;
  const sql = yield* policyDatabase;
  const rows =
    yield* sql`select id from member where id = ${actor.member} and "userId" = ${actor.user} for share`;
  if (rows.length !== 1) return yield* new OrganizationForbidden();
  return actor;
});
/** Shared resource listing for the normal app/account lists and an explicit management view. */
export const resourceDirectory = (view: "available" | "managed" = "available") =>
  Effect.gen(function* () {
    const actor = yield* currentResourceAuthority;
    const executor = yield* Effect.flatten(HostedExecutor);
    const { owner } = yield* CurrentOrganization;
    const policy = yield* CurrentAuthorization;
    const apps = yield* executor.apps.list({ owner, ids: permittedAppIds(policy) });
    const appPolicies = new Map(
      (yield* applicationAccesses(
        apps.map((app) => app.id),
        actor,
      )).map((access) => [access.app, access]),
    );
    const listedApps = apps.flatMap((app) => {
      const access = appPolicies.get(app.id);
      return access !== undefined && (view === "managed" ? access.canManage : access.canUse)
        ? [{ app, access }]
        : [];
    });
    const usableApps = listedApps.filter(({ access }) => access.canUse).map(({ app }) => app.id);
    const profiles = yield* executor.apps.profiles.listMany({
      apps: usableApps,
      owner,
      subject: actor.user,
    });
    const appEntries = listedApps.map(({ app, access }) => ({
      app,
      access,
      profiles: access.canUse ? profiles.filter((profile) => profile.app === app.id) : [],
    }));
    const selected = new Set(
      profiles.flatMap((profile) =>
        Object.values(profile.accounts).flatMap((value) =>
          typeof value === "string" ? [value] : value,
        ),
      ),
    );
    const accounts = (yield* executor.accounts.list({ owner })).filter(
      (account) => policy.tools.kind === "all" || selected.has(account.id),
    );
    const providers = new Map<ProviderId, Provider>();
    const listed = new Set(appEntries.map(({ app }) => app.id));
    const health = new Map(
      (accounts.length === 0 ? [] : yield* executor.accounts.listHealth({ owner })).map((entry) => [
        entry.account,
        { ...entry, apps: entry.apps.filter((check) => listed.has(check.app)) },
      ]),
    );
    const accountPolicies = new Map(
      (yield* accountAccesses(
        accounts.map((account) => account.id),
        actor,
      )).map((access) => [access.account, access]),
    );
    const accountEntries = yield* Effect.forEach(accounts, (account) =>
      Effect.gen(function* () {
        const access = accountPolicies.get(account.id);
        if (access === undefined || !(view === "managed" ? access.canManage : access.canUse))
          return [];
        let provider = providers.get(account.provider);
        if (provider === undefined) {
          provider = yield* executor.accounts.provider({ owner, account: account.id });
          providers.set(account.provider, provider);
        }
        const checks = health.get(account.id);
        return [
          checks === undefined
            ? { account, access, provider }
            : { account, access, provider, health: checks },
        ];
      }),
    );
    const pendingApp =
      policy.tools.kind === "all" && (view === "available" || actor.role !== "member")
        ? yield* teamAppPending(
            actor.organization,
            (yield* executor.apps.list({ owner, name: "Executor" })).length > 0,
          ).pipe(Effect.provideService(SqlClient.SqlClient, yield* policyDatabase))
        : false;
    return { apps: appEntries, accounts: accountEntries.flat(), pendingApp };
  });
/** The compare-and-swap revision protects settings and all group grants as one update. */
export const shareApp = (
  app: AppId,
  audience: typeof AppAudience.Type,
  revision: typeof AccessRevision.Type,
) =>
  Effect.gen(function* () {
    const sql = yield* policyDatabase;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const actor = yield* lockActor;
        const access = yield* requireAppAccess(app, "manage");
        if (audience.kind === "private" && access.creator === null)
          return yield* new AccessConflict({ reason: "creator_unavailable" });
        if (audience.kind === "groups")
          yield* requireGroupSharing(sql, actor.organization, actor.user, audience.groups);
        const changed =
          yield* sql`update hosted_app_access set audience = ${audience.kind}, revision = gen_random_uuid()::text
      where id = ${app} and organization_id = ${actor.organization} and revision = ${revision} returning id`;
        if (changed.length !== 1) return yield* new AccessConflict({ reason: "changed" });
        yield* sql`delete from hosted_app_groups where app_id = ${app}`;
        if (audience.kind === "groups")
          for (const group of audience.groups)
            yield* sql`insert into hosted_app_groups (organization_id, app_id, group_id) values (${actor.organization}, ${app}, ${group})`;
      }),
    );
    return yield* requireAppAccess(app, "read");
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );
/**
 * Personal account ownership cannot be changed by editing shared-account grants. The share grant
 * checks management up front; it is checked again under the transaction's lock.
 */
export const shareAccount = (
  audience: typeof SharedAudience.Type,
  revision: typeof AccessRevision.Type,
) =>
  Effect.gen(function* () {
    const { account } = yield* AccountGrants.share;
    const sql = yield* policyDatabase;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const actor = yield* lockActor;
        const access = yield* requireAccountAccess(account, "manage");
        if (access.ownership.kind === "personal")
          return yield* new AccessConflict({ reason: "personal_account" });
        if (audience.kind === "groups")
          yield* requireGroupSharing(sql, actor.organization, actor.user, audience.groups);
        const changed =
          yield* sql`update hosted_account_access set audience = ${audience.kind}, revision = gen_random_uuid()::text
      where account_id = ${account} and organization_id = ${actor.organization} and revision = ${revision} returning account_id`;
        if (changed.length !== 1) return yield* new AccessConflict({ reason: "changed" });
        yield* sql`delete from hosted_account_groups where account_id = ${account}`;
        if (audience.kind === "groups")
          for (const group of audience.groups)
            yield* sql`insert into hosted_account_groups (organization_id, account_id, group_id) values (${actor.organization}, ${account}, ${group})`;
      }),
    );
    return yield* requireAccountAccess(account, "read");
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );
/** Both hosted products register the same authenticated policy handlers. */
export const hostedResourceAccessHandlers = HttpApiBuilder.group(
  HostedApi,
  "resourceAccess",
  (handlers) =>
    Effect.gen(function* () {
      return handlers
        .handle("directory", ({ query }) => resourceDirectory(query.view))
        .handle("app", ({ params }) => requireAppAccess(params.app, "read"))
        .handle("shareApp", ({ params, payload }) =>
          shareApp(params.app, payload.audience, payload.revision),
        )
        .handle("account", () => Effect.map(AccountGrants.inspect, (grant) => grant.access))
        .handle("shareAccount", ({ payload }) => shareAccount(payload.audience, payload.revision));
    }),
);
