import { CurrentAuthorization } from "../contracts/authorization.ts";
import { permitsApp } from "@executor-js/authorization";
import { OrganizationForbidden } from "../contracts/organization.ts";
import { recordConnection, checkConnection, checkDestination } from "./connection-policy.ts";
import { accountDestination } from "./resource-lifecycle.ts";
import { requireAccountAccess, requireAppAccess, visibleApps } from "./resource-policy.ts";
import type { ConnectionDestination } from "../contracts/resource-access.ts";
/** Account use cases, connection grants and OAuth routes share the same ownership checks. */
import {
  HttpUrl,
  type AccountId,
  type AppId,
  type Executor,
  type OwnerId,
} from "@executor-js/sdk/core";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HostedApi } from "../contracts/api.ts";
import { ApiAuthentication, Authentication } from "../contracts/auth.ts";
import { CurrentOrganization } from "../contracts/organization.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { appManagerOwner, accountManagerOwner, currentOwner, ownedConnection } from "./access.ts";

/** Read provider metadata through the public SDK, including for accounts with no remaining apps. */
export const getAccount = (owner: OwnerId, account: AccountId) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* requireAccountAccess(account, "read");
    const metadata = yield* executor.accounts.get({ owner, account });
    const provider = yield* executor.accounts.provider({ owner, account });
    const policy = yield* CurrentAuthorization;
    const apps = yield* executor.apps.list({ owner, account }).pipe(
      Effect.map((apps) => apps.filter((app) => permitsApp(policy, app.id))),
      Effect.flatMap(visibleApps),
    );
    if (policy.tools.kind !== "all" && apps.length === 0) return yield* new OrganizationForbidden();
    return { account: metadata, provider, apps };
  });
/** Replace credentials on the same identity so every app keeps its selection. */
export const reconnectAccount = (owner: OwnerId, account: AccountId) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const access = yield* requireAccountAccess(account, "manage");
    const existing = yield* executor.accounts.get({ owner, account });
    const destination =
      access.ownership.kind === "personal" ? ({ kind: "personal" } as const) : access.ownership;
    yield* checkDestination(destination);
    return yield* executor.accountConnections
      .create({
        owner,
        account,
        provider: existing.provider,
      })
      .pipe(Effect.flatMap((connection) => recordConnection(connection, destination)));
  });
/** Delete saved credentials and remove their selections through the transactional lifecycle hook. */
export const disconnectAccount = (owner: OwnerId, account: AccountId) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* executor.accounts.get({ owner, account });
    return yield* executor.accounts.remove({ owner, account });
  });
/** Update metadata using the owner-filtered SDK primitive. */
export const renameAccount = (owner: OwnerId, account: AccountId, label: string) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    return yield* executor.accounts.update({ owner, account, label });
  });
/** Create a sign-in request for an app requirement belonging to this organization. */
export const connectAccount = (
  owner: OwnerId,
  input: {
    readonly app: AppId;
    readonly requirement: string;
    readonly destination?: typeof ConnectionDestination.Type | undefined;
  },
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* requireAppAccess(input.app, "manage");
    yield* executor.apps.get({ owner, app: input.app });
    yield* checkDestination(input.destination ?? { kind: "personal" });
    return yield* executor.accountConnections
      .create({ owner, target: { app: input.app, requirement: input.requirement } })
      .pipe(
        Effect.flatMap((connection) =>
          recordConnection(connection, input.destination ?? { kind: "personal" }),
        ),
      );
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
    return yield* executor.accountConnections
      .submit({ ...input, owner })
      .pipe(accountDestination(intent.destination));
  });
/** OAuth client resolution and credentials remain inside the trusted SDK. */
export const startOAuth = (
  owner: OwnerId,
  input: Omit<Parameters<Executor["accountConnections"]["startOAuth"]>[0], "owner">,
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* checkConnection(yield* ownedConnection(executor, owner, input.connection));
    return yield* executor.accountConnections.startOAuth({ ...input, owner });
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
    return yield* executor.accountConnections
      .completeOAuth({ ...input, owner })
      .pipe(accountDestination(intent.destination));
  });

/** Account policy and persisted connection ownership protect management and OAuth return requests. */
export const hostedAccountHandlers = HttpApiBuilder.group(HostedApi, "accounts", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Authentication;
    const api = yield* ApiAuthentication;
    const redirectUri = HttpUrl.make(
      auth.oauthRedirectUri ?? new URL("/api/oauth/callback", auth.origin).href,
    );
    return handlers
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const owner = yield* currentOwner;
          const data = yield* getAccount(owner, params.account);
          return {
            ...data,
            canManage: (yield* requireAccountAccess(params.account, "read")).canManage,
          };
        }),
      )
      .handle("reconnect", ({ params }) =>
        Effect.flatMap(accountManagerOwner(params.account), (owner) =>
          reconnectAccount(owner, params.account),
        ),
      )
      .handle("disconnect", ({ params }) =>
        Effect.flatMap(accountManagerOwner(params.account), (owner) =>
          disconnectAccount(owner, params.account),
        ),
      )
      .handle("rename", ({ params, payload }) =>
        Effect.flatMap(accountManagerOwner(params.account), (owner) =>
          renameAccount(owner, params.account, payload.label),
        ),
      )
      .handle("connect", ({ params, payload }) =>
        Effect.gen(function* () {
          const owner = yield* appManagerOwner(params.app);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const headers = new Headers(request.headers);
          const organization = yield* CurrentOrganization;
          const slug = headers.has("authorization")
            ? (yield* api.authenticate(headers, organization.organization)).organizationSlug
            : yield* auth.organizationSlug(headers, organization.organization);
          const connection = yield* connectAccount(owner, { app: params.app, ...payload });
          return {
            ...connection,
            url: `${auth.origin}/org/${encodeURIComponent(slug)}/connections/${encodeURIComponent(connection.id)}`,
          };
        }),
      )
      .handle("connection", ({ params }) =>
        Effect.flatMap(currentOwner, (owner) => getConnection(owner, params)).pipe(
          Effect.map((connection) => ({ ...connection, redirectUri })),
        ),
      )
      .handle("submit", ({ params, payload }) =>
        Effect.flatMap(currentOwner, (owner) =>
          submitConnection(owner, { connection: params.connection, ...payload }),
        ),
      )
      .handle("startOAuth", ({ params, payload }) =>
        Effect.flatMap(currentOwner, (owner) =>
          startOAuth(owner, { connection: params.connection, ...payload, redirectUri }),
        ).pipe(Effect.map((signIn) => ({ ...signIn, redirectUri }))),
      )
      .handle("completeOAuth", ({ params, payload }) =>
        Effect.flatMap(currentOwner, (owner) =>
          completeOAuth(owner, { connection: params.connection, ...payload }),
        ),
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
