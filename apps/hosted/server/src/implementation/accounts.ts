import { accountOAuthRedirectUri } from "./auth.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import { CurrentAuthorization } from "../contracts/authorization.ts";
import { permittedAppIds } from "@executor-js/authorization";
import { OrganizationForbidden } from "../contracts/organization.ts";
import {
  recordConnection,
  checkConnection,
  checkDestination,
  createdConnectionOrganization,
} from "./connection-policy.ts";
import { accountDestination } from "./resource-lifecycle.ts";
import { AccountGrants } from "./proofs/account-access.ts";
import { AccountTargets } from "../contracts/account-grants.ts";
import {
  currentResourceAuthority,
  policyDatabase,
  requireAppAccess,
  visibleApps,
  visibleAccounts,
} from "./resource-policy.ts";
import type { ConnectionDestination } from "../contracts/resource-access.ts";
/** Account use cases, connection grants and OAuth routes share the same ownership checks. */
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
  StorageError,
} from "@executor-js/sdk/core";
import { connectionClient, usableOAuthClients } from "./oauth-clients.ts";
import { Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import { ApiAuthentication, Authentication, CurrentPrincipal } from "../contracts/auth.ts";
import {
  CurrentOrganization,
  OrganizationSlug,
  organizationOwner,
} from "../contracts/organization.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { recordUsage } from "../contracts/product-analytics.ts";
import { currentOwner, ownedConnection } from "./access.ts";
import { appLinkApps, appLinkedAccounts, callerLinkedAccounts } from "./app-accounts.ts";
import { AccountLinkedToApp } from "../contracts/accounts.ts";
import { RequirementMismatch } from "../contracts/app-accounts.ts";

/** The apps the caller can use and linked this account to, or that link it for everyone. */
const linkedApps = (owner: OwnerId, account: AccountId) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const policy = yield* CurrentAuthorization;
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
/**
 * Read provider metadata through the public SDK, including for accounts with no remaining apps.
 * App-scoped tokens reach this only through an app they can use; see RequireAccountGrant.
 */
export const getAccount = Effect.gen(function* () {
  const { owner, account, access } = yield* AccountGrants.inspect;
  const executor = yield* Effect.flatten(HostedExecutor);
  const metadata = yield* executor.accounts.get({ owner, account });
  const provider = yield* executor.accounts.provider({ owner, account });
  const apps = yield* linkedApps(owner, account);
  const health = yield* executor.accounts.health({
    owner,
    account,
    apps: apps.map((app) => app.id),
  });
  // An unreadable grant is unreadable storage to this view.
  const { revocation } = yield* executor.accounts
    .revocation({ owner, account })
    .pipe(Effect.catchTag("CredentialsError", () => new StorageError()));
  return {
    account: metadata,
    provider,
    apps,
    health: visibleHealth(health, apps),
    revocation,
    canManage: access.canManage,
  };
});
/** Keep only the checks of apps the caller can see. */
const visibleHealth = (health: AccountHealth, apps: readonly App[]): AccountHealth => {
  const visible = new Set(apps.map((app) => app.id));
  return { ...health, apps: health.apps.filter((entry) => visible.has(entry.app)) };
};
/** Check unsaved credentials with an app the caller can use; nothing is saved. */
export const checkCredentials = (
  owner: OwnerId,
  input: Omit<Parameters<Executor["apps"]["checkCredentials"]>[0], "owner">,
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* requireAppAccess(input.app, "use");
    return yield* executor.apps.checkCredentials({ ...input, owner }).pipe(
      // Check failures may happen before the SDK resolves this caller-supplied app ID.
      Effect.tapError(() => recordUsage("account_connection_failed")),
    );
  });
/** Run the checks of the apps the caller linked the account to, with their own account access. */
export const checkAccount = Effect.gen(function* () {
  const { owner, account } = yield* AccountGrants.use;
  const executor = yield* Effect.flatten(HostedExecutor);
  const apps = yield* linkedApps(owner, account);
  const health = yield* executor.accounts.check({
    owner,
    account,
    apps: apps.map((app) => app.id),
  });
  return visibleHealth(health, apps);
});
/**
 * Check only providers reachable through the caller's app or account access. Lists the registered
 * clients the caller may use, as metadata; never a client secret.
 */
export const oauthSetup = (
  owner: OwnerId,
  input: Omit<Parameters<Executor["accountConnections"]["oauthSetup"]>[0], "owner">,
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const policy = yield* CurrentAuthorization;
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
    // Client credentials clients are each account's own; only browser sign-in shares clients.
    const clients =
      setup.grant === "client_credentials"
        ? []
        : yield* usableOAuthClients(executor, owner, yield* currentResourceAuthority, setup.issuer);
    return { ...setup, clients };
  });

/**
 * Delete saved credentials and remove their user links through the transactional lifecycle hook.
 * An account linked to an app for everyone is refused until it is unlinked: the app uses it for
 * every caller.
 */
export const disconnectAccount = Effect.gen(function* () {
  const { owner, account } = yield* AccountGrants.delete;
  const executor = yield* Effect.flatten(HostedExecutor);
  yield* executor.accounts.get({ owner, account });
  const [first, ...rest] = yield* appLinkApps(yield* policyDatabase, account);
  if (first !== undefined)
    return yield* new AccountLinkedToApp({ account, apps: [first, ...rest] });
  return yield* executor.accounts.remove({ owner, account });
});
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
/**
 * Create a sign-in request for an app requirement in the scope the route names. Completing it
 * links the new account to the requirement: for the caller for a user requirement, for everyone for
 * an app requirement, which only people who can edit the app may do. With `account`, it replaces
 * that account's credentials; there is no reconnect outside an app.
 */
export const connectAccount = (
  owner: OwnerId,
  input: {
    readonly app: AppId;
    readonly requirement: string;
    readonly scope: AccountScope;
    readonly destination?: typeof ConnectionDestination.Type | undefined;
    readonly account?: AccountId | undefined;
  },
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* requireAppAccess(input.app, input.scope === "app" ? "manage" : "use");
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
    // A reconnect keeps the account where it is shared; a new account goes where the caller asks.
    const reconnect =
      input.account === undefined
        ? undefined
        : yield* AccountGrants.reconnect.pipe(
            Effect.provideService(AccountTargets.reconnect, { account: input.account }),
          );
    const destination =
      reconnect === undefined
        ? (input.destination ?? ({ kind: "personal" } as const))
        : reconnect.access.ownership.kind === "personal"
          ? ({ kind: "personal" } as const)
          : reconnect.access.ownership;
    yield* checkDestination(destination);
    return yield* executor.accountConnections
      .create({
        owner,
        target: { app: input.app, requirement: input.requirement, scope: input.scope },
        ...(input.account === undefined ? {} : { account: input.account }),
      })
      .pipe(Effect.flatMap((connection) => recordConnection(connection, destination, input.scope)));
  });
/** The dashboard page where a connection's creator finishes it, under the caller's slug. */
export const connectionUrl = (
  auth: Authentication["Service"],
  api: ApiAuthentication["Service"],
  connection: AccountConnectionId,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const headers = new Headers(request.headers);
    const organization = yield* CurrentOrganization;
    const slug = headers.has("authorization")
      ? (yield* api.authenticate(headers, organization.organization)).organizationSlug
      : yield* auth.organizationSlug(headers, organization.organization);
    return `${auth.origin}/org/${encodeURIComponent(slug)}/connections/${encodeURIComponent(connection)}`;
  });
/** Connection metadata never grants access to another organization's request or app. */
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
/** Save credentials and complete the connection's selected app requirement. */
export const submitConnection = (
  owner: OwnerId,
  input: Omit<Parameters<Executor["accountConnections"]["submit"]>[0], "owner">,
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const intent = yield* checkConnection(
      yield* ownedConnection(executor, owner, input.connection),
    );
    return yield* executor.accountConnections.submit({ ...input, owner }).pipe(
      accountDestination(intent.destination),
      Effect.tapError(() =>
        recordUsage("account_connection_failed", { app_id: intent.target.app }),
      ),
      Effect.tap(() => Effect.flatten(ScheduleWakeup)),
    );
  });
/**
 * The member's client choice is checked against its audience here, then named to the SDK, which
 * keeps client secrets and protocol state. Entered clients sign in this account only.
 */
export const startOAuth = (
  owner: OwnerId,
  input: Omit<Parameters<Executor["accountConnections"]["startOAuth"]>[0], "owner" | "client"> & {
    readonly client?: OAuthClientSelection | undefined;
  },
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const intent = yield* checkConnection(
      yield* ownedConnection(executor, owner, input.connection),
    );
    const client = yield* connectionClient(executor, owner, input);
    const { client: _selected, ...rest } = input;
    return yield* executor.accountConnections
      .startOAuth({ ...rest, owner, ...(client === undefined ? {} : { client }) })
      .pipe(accountDestination(intent.destination));
  });
/** Completion rechecks connection and target ownership before saving provider credentials. */
export const completeOAuth = (
  owner: OwnerId,
  input: Omit<Parameters<Executor["accountConnections"]["completeOAuth"]>[0], "owner">,
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const intent = yield* checkConnection(
      yield* ownedConnection(executor, owner, input.connection),
    );
    return yield* executor.accountConnections.completeOAuth({ ...input, owner }).pipe(
      accountDestination(intent.destination),
      Effect.tapError(() =>
        recordUsage("account_connection_failed", { app_id: intent.target.app }),
      ),
      Effect.tap(() => Effect.flatten(ScheduleWakeup)),
    );
  });

/** Account policy and persisted connection ownership protect management and OAuth return requests. */
export const hostedAccountHandlers = HttpApiBuilder.group(HostedApi, "accounts", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Authentication;
    const api = yield* ApiAuthentication;
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
          submitConnection(owner, { connection: params.connection, ...payload }),
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

/**
 * A provider's link can open in a tab or browser without the page that started sign-in. The
 * callback's state finds the pending connection, which only its creator, still a member of its
 * organization, may resume. Completion then runs the organization route's full checks.
 */
export const hostedOAuthCallbackHandlers = HttpApiBuilder.group(
  HostedApi,
  "oauthCallback",
  (handlers) =>
    Effect.gen(function* () {
      const auth = yield* Authentication;
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
            // The callback this sign-in sent, which a saved client may have kept from before.
            redirectUri: connection.redirectUri,
            reconnect: connection.reconnectAccount !== null,
          };
        }),
      );
    }),
);

/** Keep the existing provider redirect URL. Completion still requires the browser session and membership. */
export const hostedOAuthCallback = Effect.gen(function* () {
  const { origin } = yield* Authentication;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, "https://callback.internal");
  return HttpServerResponse.redirect(`${origin}/oauth/callback${url.search}`).pipe(
    HttpServerResponse.setHeader("cache-control", "no-store"),
    HttpServerResponse.setHeader("referrer-policy", "no-referrer"),
  );
});
