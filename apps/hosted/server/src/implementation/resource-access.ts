import { CurrentPolicy } from "../contracts/authorization.ts";
import { permittedAppIds } from "@executor-js/authorization";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { teamAppPending } from "./provisioning.ts";
import { HttpApiBuilder } from "effect/http-api";
import {
  isProvisionedMethod,
  StorageError,
  type AppId,
  type Provider,
  type ProviderId,
} from "@executor-js/sdk/core";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { CurrentOrganization } from "../contracts/organization.ts";
import {
  AccessConflict,
  type AppAudience,
  type AccessRevision,
} from "../contracts/resource-access.ts";
import { requireGroupSharing } from "./group-sharing.ts";
import { appLinkedAccounts, callerLinkedAccounts } from "./app-accounts.ts";
import {
  policyDatabase,
  currentResourceAuthority,
  lockCurrentActor as lockActor,
  applicationAccesses,
  ownedAccountIds,
  requireAppAccess,
} from "./resource-policy.ts";

export const resourceDirectory = (view: "available" | "managed" = "available") =>
  Effect.gen(function* () {
    const actor = yield* currentResourceAuthority;
    const executor = yield* Effect.flatten(HostedExecutor);
    const { owner } = yield* CurrentOrganization;
    const policy = yield* CurrentPolicy;
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
    const links = yield* callerLinkedAccounts(usableApps);
    const appLinks = yield* appLinkedAccounts(yield* policyDatabase, usableApps);
    const appEntries = listedApps.map(({ app, access }) => ({
      app,
      access,
      linkedAccounts: [
        ...new Set(links.filter((link) => link.app === app.id).map((link) => link.id)),
      ],
      appLinks: appLinks.flatMap((link) =>
        link.app === app.id
          ? [
              {
                requirement: link.requirement,
                account: link.id,
                provider: link.provider,
                label: link.label,
              },
            ]
          : [],
      ),
    }));
    const linked = new Set(links.map((link) => link.id));
    const accounts = (yield* executor.accounts.list({ owner })).filter(
      (account) => policy.tools.kind === "all" || linked.has(account.id),
    );
    const providers = new Map<ProviderId, Provider>();
    const checked = [
      ...new Map(
        [...links, ...appLinks].map((link) => [
          `${link.app}\u0000${link.id}`,
          { account: link.id, app: link.app },
        ]),
      ).values(),
    ];
    const health = new Map(
      (accounts.length === 0
        ? []
        : yield* executor.accounts.listHealth({ owner, links: checked })
      ).map((entry) => [entry.account, entry]),
    );
    const owned = yield* ownedAccountIds(
      accounts.map((account) => account.id),
      actor,
    );
    const accountEntries = yield* Effect.forEach(accounts, (account) =>
      Effect.gen(function* () {
        if (!owned.has(account.id)) return [];
        let provider = providers.get(account.provider);
        if (provider === undefined) {
          provider = yield* executor.accounts.provider({ owner, account: account.id });
          providers.set(account.provider, provider);
        }
        if (isProvisionedMethod(provider.definition, account.method)) return [];
        const checks = health.get(account.id);
        return [
          checks === undefined ? { account, provider } : { account, provider, health: checks },
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
        );
    }),
);
