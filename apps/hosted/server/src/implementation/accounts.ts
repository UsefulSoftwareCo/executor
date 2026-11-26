import { visibleAccountHealth, visibleAccountStatuses } from "./account-identity.ts";
import {
  requireRequirementAccess,
  checkContributedAccountRemoval,
} from "./contributed-account-policy.ts";
import { accountOAuthRedirectUri } from "./auth.ts";
import { audited } from "./security-audit.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import { CurrentPolicy } from "../contracts/authorization.ts";
import { permittedAppIds } from "@executor-js/authorization";
import { OrganizationForbidden } from "../contracts/organization.ts";
import {
  recordConnection,
  checkConnection,
  createdConnectionOrganization,
} from "./connection-policy.ts";
import { AccountGrants } from "./proofs/account-access.ts";
import { AccountTargets } from "../contracts/account-grants.ts";
import {
  currentResourceAuthority,
  policyDatabase,
  requireAppAccess,
  visibleApps,
  visibleAccounts,
} from "./resource-policy.ts";
import {
  type AccountConnectionId,
  type AccountScope,
  type AccountHealth,
  type AccountId,
  type App,
  type AppId,
  type Executor,
  type OwnerId,
  type OAuthClientSelection,
  type JsonObject,
  StorageError,
  StorageHost,
} from "@executor-js/sdk/core";
import { connectionClient, usableOAuthClients } from "./oauth-clients.ts";
import { Effect, Option, Redacted, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import {
  BearerAuthentication,
  SessionAuthentication,
  CurrentPrincipal,
  CurrentUserId,
} from "../contracts/auth.ts";
import {
  OrganizationReference,
  OrganizationSlug,
  organizationOwner,
} from "../contracts/organization.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { currentOrganizationSlug, currentOwner, ownedConnection } from "./access.ts";
import { appLinkApps, appLinkedAccounts, callerLinkedAccounts } from "./app-accounts.ts";
import { AccountLinkedToApp, ExecutorKeyRefused } from "../contracts/accounts.ts";
import { visibleAccountRefusal } from "./webhooks.ts";
import { RequirementMismatch } from "../contracts/app-accounts.ts";

const linkedApps = (owner: OwnerId, account: AccountId) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const policy = yield* CurrentPolicy;
    const apps = yield* executor.apps
      .list({ owner, ids: permittedAppIds(policy) })
      .pipe(Effect.flatMap(visibleApps));
    const ids = apps.map((app) => app.id);
    const linked = new Set(
      [
        ...(yield* callerLinkedAccounts(ids)),
        ...(yield* appLinkedAccounts(yield* policyDatabase, ids)),
      ]
        .filter((entry) => entry.id === account)
        .map((entry) => entry.app),
    );
    return apps.filter((app) => linked.has(app.id));
  });
export const getAccount = Effect.gen(function* () {
  const { owner, account } = yield* AccountGrants.inspect;
  const executor = yield* Effect.flatten(HostedExecutor);
  const metadata = yield* executor.accounts.get({ owner, account });
  const provider = yield* executor.accounts.provider({ owner, account });
  const apps = yield* linkedApps(owner, account);
  const health = yield* executor.accounts.health({
    owner,
    account,
    apps: apps.map((app) => app.id),
  });
  const { revocation } = yield* executor.accounts
    .revocation({ owner, account })
    .pipe(Effect.catchTag("CredentialsError", () => new StorageError()));
  const [status] = yield* visibleAccountStatuses([
    { account: metadata, health: visibleHealth(health, apps) },
  ]);
  return {
    ...status!,
    provider,
    apps,
    revocation,
    canManage: true,
  };
});
const visibleHealth = (health: AccountHealth, apps: readonly App[]): AccountHealth => {
  const visible = new Set(apps.map((app) => app.id));
  return { ...health, apps: health.apps.filter((entry) => visible.has(entry.app)) };
};
export const checkCredentials = (
  owner: OwnerId,
  input: Omit<Parameters<Executor["apps"]["checkCredentials"]>[0], "owner">,
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* requireAppAccess(input.app, "use");
    return yield* executor.apps.checkCredentials({ ...input, owner });
  });
export const checkAccount = Effect.gen(function* () {
  const { owner, account } = yield* AccountGrants.use;
  const executor = yield* Effect.flatten(HostedExecutor);
  const apps = yield* linkedApps(owner, account);
  const health = yield* executor.accounts
    .check({ owner, account, apps: apps.map((app) => app.id) })
    .pipe(audited("credential.read", { kind: "account", id: () => account }, { purpose: "check" }));
  return yield* visibleAccountHealth(visibleHealth(health, apps));
});
export const oauthSetup = (
  owner: OwnerId,
  input: Omit<Parameters<Executor["accountConnections"]["oauthSetup"]>[0], "owner">,
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const policy = yield* CurrentPolicy;
    const apps = yield* executor.apps
      .list({ owner, ids: permittedAppIds(policy) })
      .pipe(Effect.flatMap(visibleApps));
    const installed = apps.some((app) =>
      Object.values(app.requirements.accounts).some(
        (requirement) => requirement.provider === input.provider,
      ),
    );
    if (
      !installed &&
      (policy.tools.kind !== "all" ||
        (yield* executor.accounts
          .list({ owner, provider: input.provider })
          .pipe(Effect.flatMap(visibleAccounts))).length === 0)
    )
      return yield* new OrganizationForbidden();
    const setup = yield* executor.accountConnections.oauthSetup({ ...input, owner });
    const clients =
      setup.grant === "client_credentials"
        ? []
        : yield* usableOAuthClients(executor, owner, yield* currentResourceAuthority, setup.issuer);
    return { ...setup, clients };
  });

/**
 * Delete saved credentials and remove their user links through the transactional lifecycle hook.
 * An account linked to an app for everyone is refused until it is unlinked: the app uses it for
 * every caller. One a webhook subscription holds is refused naming only the holders the caller
 * may see.
 */
export const removeAccount = ({
  owner,
  account,
}: {
  readonly owner: OwnerId;
  readonly account: AccountId;
}) =>
  Effect.gen(function* () {
  const executor = yield* Effect.flatten(HostedExecutor);
  yield* executor.accounts.get({ owner, account });
  const sql = yield* policyDatabase;
  yield* executor[StorageHost].transaction(checkContributedAccountRemoval(sql, account));
  const [first, ...rest] = yield* appLinkApps(sql, account, true);
  if (first !== undefined)
    return yield* new AccountLinkedToApp({ account, apps: [first, ...rest] });
  return yield* executor.accounts
    .remove({ owner, account })
    .pipe(
      Effect.catchTag("AccountWebhooksActive", (refusal) =>
        Effect.flatMap(visibleAccountRefusal(executor, refusal), Effect.fail),
      ),
    );
  });
export const disconnectAccount = Effect.flatMap(AccountGrants.delete, removeAccount);
/** Update the label or description using the owner-filtered SDK primitive. */
export const updateAccount = (metadata: {
  readonly label?: string | undefined;
  readonly description?: string | null | undefined;
}) =>
  Effect.gen(function* () {
    const { owner, account } = yield* AccountGrants.rename;
    const executor = yield* Effect.flatten(HostedExecutor);
    return yield* executor.accounts.update({ ...metadata, owner, account });
  });
export const connectAccount = (
  owner: OwnerId,
  input: {
    readonly app: AppId;
    readonly requirement: string;
    readonly scope: AccountScope;
    readonly account?: AccountId | undefined;
  },
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* requireRequirementAccess(input);
    const app = yield* executor.apps.get({ owner, app: input.app });
    const required = Object.hasOwn(app.requirements.accounts, input.requirement)
      ? app.requirements.accounts[input.requirement]
      : undefined;
    if (required === undefined || required.scope !== input.scope)
      return yield* new RequirementMismatch({
        app: input.app,
        requirement: input.requirement,
        scope: input.scope,
        reason: "requirement",
      });
    if (input.account !== undefined)
      yield* AccountGrants.reconnect.pipe(
        Effect.provideService(AccountTargets.reconnect, { account: input.account }),
      );
    return yield* executor.accountConnections
      .create({
        owner,
        target: { app: input.app, requirement: input.requirement, scope: input.scope },
        ...(input.account === undefined ? {} : { account: input.account }),
      })
      .pipe(Effect.flatMap((connection) => recordConnection(connection, input.scope)));
  });
export const connectionUrl = (
  auth: SessionAuthentication["Service"],
  api: BearerAuthentication["Service"],
  connection: AccountConnectionId,
) =>
  Effect.gen(function* () {
    const slug = yield* currentOrganizationSlug(auth, api);
    return `${auth.origin}/org/${encodeURIComponent(slug)}/connections/${encodeURIComponent(connection)}`;
  });
export const getConnection = (
  owner: OwnerId,
  input: Omit<Parameters<Executor["accountConnections"]["get"]>[0], "owner">,
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const connection = yield* ownedConnection(executor, owner, input.connection);
    yield* checkConnection(connection);
    return connection;
  });
const ExecutorKeyFields = Schema.Struct({ token: Schema.String, organization: Schema.String });
const checkExecutorKey = (owner: OwnerId, app: AppId, fields: Redacted.Redacted<JsonObject>) =>
  Effect.gen(function* () {
    if (!owner.startsWith("organization:")) return;
    const sql = yield* policyDatabase;
    const rows = yield* sql`select id from "organization"
      where id = ${owner.slice("organization:".length)}
      and metadata::jsonb -> 'executorDefaults' ->> 'app' = ${app}`.pipe(
      Effect.mapError(() => new StorageError()),
    );
    if (rows.length === 0) return;
    const entered = Option.getOrUndefined(
      Schema.decodeUnknownOption(ExecutorKeyFields)(Redacted.value(fields)),
    );
    if (entered === undefined) return;
    const organization = Option.getOrUndefined(
      Schema.decodeUnknownOption(OrganizationReference)(entered.organization),
    );
    if (organization === undefined)
      return yield* new ExecutorKeyRefused({ reason: "organization" });
    const api = yield* BearerAuthentication;
    yield* api
      .authenticate(
        new Headers({
          authorization: `Bearer ${entered.token}`,
          "x-executor-organization": organization,
        }),
        organization,
      )
      .pipe(
        Effect.catchTags({
          Unauthorized: () => new ExecutorKeyRefused({ reason: "token" }),
          OrganizationForbidden: () =>
            Effect.gen(function* () {
              const user = yield* CurrentUserId;
              const named =
                yield* sql`select o.id from "organization" o join member m on m."organizationId" = o.id
                where m."userId" = ${user ?? null} and o.name = ${entered.organization} limit 1`.pipe(
                  Effect.mapError(() => new StorageError()),
                );
              return yield* new ExecutorKeyRefused({
                reason: named.length === 0 ? "unreachable" : "organization",
              });
            }),
        }),
      );
  });
export const submitConnection = (
  owner: OwnerId,
  input: Omit<Parameters<Executor["accountConnections"]["submit"]>[0], "owner">,
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const connection = yield* ownedConnection(executor, owner, input.connection);
    yield* checkConnection(connection);
    if (input.method === "apiKey")
      yield* checkExecutorKey(owner, connection.target.app, input.fields);
    return yield* executor.accountConnections
      .submit({ ...input, owner })
      .pipe(Effect.tap(() => Effect.flatten(ScheduleWakeup)));
  });
export const startOAuth = (
  owner: OwnerId,
  input: Omit<Parameters<Executor["accountConnections"]["startOAuth"]>[0], "owner" | "client"> & {
    readonly client?: OAuthClientSelection | undefined;
  },
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* checkConnection(yield* ownedConnection(executor, owner, input.connection));
    const client = yield* connectionClient(executor, owner, input);
    const { client: _selected, ...rest } = input;
    return yield* executor.accountConnections.startOAuth({
      ...rest,
      owner,
      ...(client === undefined ? {} : { client }),
    });
  });
export const completeOAuth = (
  owner: OwnerId,
  input: Omit<Parameters<Executor["accountConnections"]["completeOAuth"]>[0], "owner">,
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* checkConnection(yield* ownedConnection(executor, owner, input.connection));
    return yield* executor.accountConnections
      .completeOAuth({ ...input, owner })
      .pipe(Effect.tap(() => Effect.flatten(ScheduleWakeup)));
  });

export const hostedAccountHandlers = HttpApiBuilder.group(HostedApi, "accounts", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* SessionAuthentication;
    const api = yield* BearerAuthentication;
    const redirectUri = accountOAuthRedirectUri(auth);
    return handlers
      .handle("get", () => getAccount)
      .handle("checkCredentials", ({ params, payload }) =>
        Effect.flatMap(currentOwner, (owner) =>
          checkCredentials(owner, { app: params.app, ...payload }),
        ),
      )
      .handle("check", () => checkAccount)
      .handle("disconnect", () => disconnectAccount)
      .handle("update", ({ payload }) => updateAccount(payload))
      .handle("oauthSetup", ({ params }) =>
        Effect.flatMap(currentOwner, (owner) =>
          oauthSetup(owner, { provider: params.provider, method: params.method, redirectUri }),
        ),
      )
      .handle("connection", ({ params }) =>
        Effect.gen(function* () {
          const owner = yield* currentOwner;
          const connection = yield* getConnection(owner, params);
          const target = connection.target;
          const app = yield* Effect.flatten(HostedExecutor).pipe(
            Effect.flatMap((executor) => executor.apps.get({ owner, app: target.app })),
          );
          const requirement = app.requirements.accounts[target.requirement];
          return {
            ...connection,
            url: yield* connectionUrl(auth, api, connection.id),
            redirectUri,
            checkable: requirement?.health === true,
          };
        }),
      )
      .handle("submit", ({ params, payload }) =>
        Effect.flatMap(currentOwner, (owner) =>
          submitConnection(owner, { connection: params.connection, ...payload }).pipe(
            Effect.provideService(BearerAuthentication, api),
          ),
        ),
      )
      .handle("startOAuth", ({ params, payload }) =>
        Effect.flatMap(currentOwner, (owner) =>
          startOAuth(owner, { connection: params.connection, ...payload, redirectUri }),
        ),
      )
      .handle("completeOAuth", ({ params, payload }) =>
        Effect.flatMap(currentOwner, (owner) =>
          completeOAuth(owner, { connection: params.connection, ...payload }),
        ),
      );
  }),
);

export const hostedOAuthCallbackHandlers = HttpApiBuilder.group(
  HostedApi,
  "oauthCallback",
  (handlers) =>
    Effect.gen(function* () {
      const auth = yield* SessionAuthentication;
      return handlers.handle("resolve", ({ payload }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          const executor = yield* Effect.flatten(HostedExecutor);
          const connection = yield* executor.accountConnections.findOAuth(payload);
          const organization = yield* createdConnectionOrganization(
            connection.id,
            principal.userId,
          );
          if (organizationOwner(organization) !== connection.owner)
            return yield* new OrganizationForbidden();
          yield* auth.membership(principal, organization);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const organizationSlug = yield* auth
            .organizationSlug(new Headers(request.headers), organization)
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(OrganizationSlug)),
              Effect.catchTag("SchemaError", () => new StorageError()),
            );
          return {
            organizationSlug,
            connection: connection.id,
            app: connection.target.app,
            redirectUri: connection.redirectUri,
            reconnect: connection.reconnectAccount !== null,
          };
        }),
      );
    }),
);

export const hostedOAuthCallback = Effect.gen(function* () {
  const { origin } = yield* SessionAuthentication;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, "https://callback.internal");
  return HttpServerResponse.redirect(`${origin}/oauth/callback${url.search}`).pipe(
    HttpServerResponse.setHeader("cache-control", "no-store"),
    HttpServerResponse.setHeader("referrer-policy", "no-referrer"),
  );
});
