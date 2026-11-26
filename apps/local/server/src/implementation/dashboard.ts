import { sourceDisplay, sourceDisplayFile } from "@executor-js/app-management/source-display";
import { connectOptions, connectionClient } from "./oauth-clients.ts";
import { localResourceHandlers } from "./resources.ts";
import {
  accountLinks,
  appAccountLinks,
  appAccountRequirement,
  appLinkApps,
  callerAccounts,
  linkAccount,
  requireScopedRequirement,
  unlinkAccount,
} from "./app-accounts.ts";
import { appOrigin } from "../contracts/app-ui.ts";
import {
  StorageError,
  AppNameTaken,
  HttpUrl,
  type AccountFieldsInput,
  type AccountScope,
  type AuthMethodName,
  type OAuthClientSelection,
  RequestInvalid,
  ToolApprovalIssuer,
  ToolApprovalNotFound,
  invocationEntries,
  type App,
  type AppId,
  type ApprovalRequestId,
  type AccountId,
  type ExecutorDatabase,
  type Executor,
} from "@executor-js/sdk/core";
import { Effect, Layer, Result, Schema, Stream } from "effect";
import type { SqlClient } from "effect/sql";
import { ApprovalResponse, approvalElicitation } from "apps/contracts";
import { type AppUiPages, type UiFailed } from "apps/ui/contracts";
import {
  ToolRunApprovalRefused,
  type BrowserApprovalView,
  type BrowserToolRun,
} from "@executor-js/mcp/browser";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { localBearer, localRequest, requestOrigin, sessionCookie, type LocalAuth } from "./auth.ts";
import { createCatalog, deployedCopy } from "@executor-js/catalog";
import type { LocalOwnerMigration } from "@executor-js/app-management/contracts/local-owners";
import { connectForApp } from "./account-connections.ts";
import { localOwner as owner, localOwners } from "./owners.ts";
import type { HostEgress } from "@executor-js/utils/url-policy";
import type { AuthStorageError } from "../contracts/auth.ts";
import type { ServerConfig } from "../contracts/config.ts";
import {
  DashboardAccess,
  DashboardApi,
  DashboardForbidden,
  DashboardUnauthorized,
  ToolDiscoveryTimedOut,
  OAuthCallbackPath,
  providerDisplayUrl,
  AppDeletionBlocked,
  AppRenameBlocked,
  AppAccountLinksBlocked,
  AccountManagementBlocked,
  AccountLinkedToApp,
  type AppAccountTarget,
} from "../contracts/dashboard.ts";

export const browserOnly = (config: ServerConfig, auth: LocalAuth) =>
  Effect.gen(function* () {
    const request = yield* localRequest(config.port, config.browserOrigin).pipe(
      Effect.mapError(() => new DashboardForbidden()),
    );
    if (
      request.headers.authorization !== undefined ||
      (request.method === "POST" && request.headers.origin !== requestOrigin(config, request))
    )
      return yield* new DashboardForbidden();
    if (!(yield* auth.valid(request.cookies[sessionCookie(config)])))
      return yield* new DashboardUnauthorized();
  });
const dashboardRun = ToolApprovalIssuer.make("dashboard");
export const dashboardAccess = (config: ServerConfig, auth: LocalAuth) =>
  Layer.succeed(DashboardAccess, (response) =>
    Effect.gen(function* () {
      const request = yield* localRequest(config.port, config.browserOrigin).pipe(
        Effect.mapError(() => new DashboardForbidden()),
      );
      const bearer = localBearer(config, request.headers.authorization);
      const session = yield* auth.valid(request.cookies[sessionCookie(config)]);
      if (!bearer && !session) return yield* Effect.fail(new DashboardUnauthorized());
      return (yield* response).pipe(HttpServerResponse.setHeader("cache-control", "no-store"));
    }),
  );

export const dashboard = (
  executor: Executor,
  sql: SqlClient.SqlClient,
  reactivity: ExecutorDatabase["reactivity"],
  config: ServerConfig,
  auth: LocalAuth,
  egress: HostEgress,
  {
    catalogFeedUrl,
    managedApp,
    managedAccount,
    ownerMigration,
    wakeWebhookSources,
    uiPages,
    uiIcon,
  }: {
    readonly catalogFeedUrl?: string | undefined;
    readonly managedApp?: AppId;
    readonly managedAccount?: AccountId;
    readonly ownerMigration: Effect.Effect<LocalOwnerMigration | null>;
    readonly wakeWebhookSources: Effect.Effect<void>;
    readonly uiPages: (app: App) => Effect.Effect<AppUiPages, UiFailed>;
    readonly uiIcon: (
      app: App,
    ) => Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      HttpServerRequest.HttpServerRequest
    >;
  },
) => {
  const appCatalog = createCatalog({
    egress,
    clientMetadataUrl: config.oauthClientMetadataUrl,
    feedUrl: catalogFeedUrl,
  });
  const signIn = (account: AccountId) =>
    executor.accounts.signIn({ account }).pipe(
      Effect.map((state) =>
        state.state === "saved"
          ? ({ state: "saved", reconnectAt: state.reconnectAt } as const)
          : ({ state: state.state } as const),
      ),
      Effect.catch(() => Effect.succeed({ state: "unavailable" } as const)),
    );
  const manage = <A, E, R>(account: AccountId, operation: Effect.Effect<A, E, R>) =>
    account === managedAccount ? Effect.fail(new AccountManagementBlocked({ account })) : operation;
  const changeLinks = <A, E, R>(app: AppId, operation: Effect.Effect<A, E, R>) =>
    app === managedApp ? Effect.fail(new AppAccountLinksBlocked({ app })) : operation;
  const appConnection = (
    params: { readonly app: AppId; readonly requirement: string },
    scope: AccountScope,
    target: typeof AppAccountTarget.Type,
  ) =>
    Effect.gen(function* () {
      if (params.app === managedApp) return yield* new AppAccountLinksBlocked({ app: params.app });
      yield* requireScopedRequirement(executor, { ...params, scope });
      const connectionTarget = { app: params.app, requirement: params.requirement, scope };
      return yield* target.account === undefined
        ? connectForApp(executor, managedApp, { target: connectionTarget })
        : manage(
            target.account,
            connectForApp(executor, managedApp, {
              account: target.account,
              target: connectionTarget,
            }),
          );
    });
  const connectWithFields = (
    params: { readonly app: AppId; readonly requirement: string },
    scope: AccountScope,
    payload: typeof AppAccountTarget.Type & {
      readonly method: typeof AuthMethodName.Type;
      readonly label?: string | undefined;
      readonly fields: typeof AccountFieldsInput.Type;
    },
  ) =>
    Effect.gen(function* () {
      const { method, label, fields, ...target } = payload;
      const connection = yield* appConnection(params, scope, target);
      return yield* executor.accountConnections.submit({
        connection: connection.id,
        method,
        ...(label === undefined ? {} : { label }),
        fields,
      });
    }).pipe(Effect.tap(() => wakeWebhookSources));
  const connectWithOAuth = (
    params: { readonly app: AppId; readonly requirement: string },
    scope: AccountScope,
    payload: typeof AppAccountTarget.Type & {
      readonly method: typeof AuthMethodName.Type;
      readonly label?: string | undefined;
      readonly client?: OAuthClientSelection | undefined;
      readonly chooseAgain?: true | undefined;
    },
  ) =>
    Effect.gen(function* () {
      const { method, label, client, chooseAgain, ...target } = payload;
      const request = yield* localRequest(config.port, config.browserOrigin).pipe(
        Effect.mapError(() => new DashboardForbidden()),
      );
      const connection = yield* appConnection(params, scope, target);
      const chosen = yield* connectionClient(connection, { method, client });
      const signIn = yield* executor.accountConnections.startOAuth({
        connection: connection.id,
        method,
        ...(label === undefined ? {} : { label }),
        ...(chosen === undefined ? {} : { client: chosen }),
        ...(chooseAgain === true ? { chooseAgain } : {}),
        redirectUri: new URL(OAuthCallbackPath, requestOrigin(config, request)).href,
      });
      return { ...signIn, connection: connection.id };
    });
  const access = dashboardAccess(config, auth);
  const reviewedTool = (app: AppId, requestId: ApprovalRequestId) =>
    Effect.gen(function* () {
      yield* browserOnly(config, auth);
      const pending = yield* executor.tools.approval({ requestId, owner });
      if (pending.issuer !== dashboardRun)
        return yield* new ToolRunApprovalRefused({
          reason: pending.issuer === undefined ? "unrecorded" : "another-person",
        });
      if (pending.invocation.app !== app) return yield* new ToolApprovalNotFound({ requestId });
      const found = yield* executor.apps.get({ app });
      return { ...pending, appName: found.name };
    });
  const overview = Effect.gen(function* () {
    const { apps, accounts, providers } = yield* Effect.all(
      {
        apps: executor.apps.list(),
        accounts: Effect.forEach(localOwners, (each) =>
          executor.accounts.list({ owner: each }),
        ).pipe(Effect.map((lists) => lists.flat())),
        providers: Effect.forEach(localOwners, (each) =>
          executor.accounts.providers({ owner: each }),
        ).pipe(Effect.map((lists) => lists.flat())),
      },
      { concurrency: 4 },
    );
    const all = yield* accountLinks(sql, executor);
    const pairs = (subjectScoped: boolean) => {
      const seen = new Set<string>();
      return all.flatMap((link) => {
        const key = `${link.app}\u0000${link.account}`;
        if ((subjectScoped && link.subject === null) || seen.has(key)) return [];
        seen.add(key);
        return [{ app: link.app, account: link.account }];
      });
    };
    const links = pairs(true);
    const listed = new Map(accounts.map((account) => [account.id, account]));
    const appLinks = all.flatMap((link) => {
      const account = listed.get(link.account);
      return link.subject !== null || account === undefined
        ? []
        : [
            {
              app: link.app,
              requirement: link.requirement,
              account: account.id,
              provider: account.provider,
              label: account.label,
            },
          ];
    });
    const health = yield* executor.accounts.listHealth({ links: pairs(false) });
    const checks = new Map(health.map((entry) => [entry.account, entry]));
    const definitions = new Map(providers.map((provider) => [provider.id, provider.definition]));
    const display = [];
    for (const account of accounts) {
      const definition = definitions.get(account.provider);
      if (definition === undefined) return yield* Effect.fail(new StorageError());
      const health = checks.get(account.id);
      display.push({
        ...account,
        providerName: definition.name,
        providerUrl: providerDisplayUrl(definition),
        signIn: yield* signIn(account.id),
        ...(health === undefined ? {} : { health }),
      });
    }
    return { apps, links, appLinks, accounts: display };
  });
  const appDetail = (appId: AppId) =>
    Effect.gen(function* () {
      const app = yield* executor.apps.get({ app: appId });
      const versions = yield* executor.apps.versions({ app: appId });
      const pages = yield* uiPages(app).pipe(Effect.mapError(() => new StorageError()));
      const served = app.owner === owner;
      return {
        app,
        uiUrl: served && pages.main ? HttpUrl.make(appOrigin(app.id, config.port)) : null,
        uiIcon: pages.icon,
        uiMenuBar: served && pages.menuBar,
        canDelete: app.id !== managedApp,
        versions,
      };
    });
  const linkedApps = (account: AccountId) =>
    Effect.gen(function* () {
      const found = yield* executor.accounts.get({ account });
      const linked = new Set(
        (yield* accountLinks(sql, executor, found.id)).map((link) => link.app),
      );
      return (yield* executor.apps.list()).filter((app) => linked.has(app.id));
    });
  const resolved = (appId: AppId) =>
    Effect.gen(function* () {
      const app: App = yield* executor.apps.get({ app: appId });
      return { app, accounts: yield* callerAccounts(sql, executor, app) };
    });
  const accountDetail = (accountId: AccountId) =>
    Effect.gen(function* () {
      const account = yield* executor.accounts.get({ account: accountId });
      const provider = yield* executor.accounts
        .provider({ account: accountId })
        .pipe(Effect.catchTag("ProviderNotFound", () => new StorageError()));
      const apps = yield* linkedApps(account.id);
      const health = yield* executor.accounts.health({
        account: account.id,
        apps: apps.map((app) => app.id),
      });
      const { revocation } = yield* executor.accounts
        .revocation({ account: account.id })
        .pipe(Effect.catchTag("CredentialsError", () => new StorageError()));
      return {
        account: {
          ...account,
          providerName: provider.definition.name,
          providerUrl: providerDisplayUrl(provider.definition),
          signIn: yield* signIn(account.id),
        },
        provider,
        apps,
        health,
        revocation,
        canManage: account.id !== managedAccount,
      };
    });

  type LiveAccess = Effect.Effect<void, DashboardUnauthorized | AuthStorageError>;
  const secureLive = <A, E>(
    subscribe: (authorize: LiveAccess) => Stream.Stream<
      {
        readonly revision: number;
        readonly value: Result.Result<A, E>;
      },
      DashboardUnauthorized | AuthStorageError
    >,
  ) =>
    Effect.gen(function* () {
      const request = yield* localRequest(config.port, config.browserOrigin).pipe(
        Effect.mapError(() => new DashboardForbidden()),
      );
      const bearer = localBearer(config, request.headers.authorization);
      const cookie = request.cookies[sessionCookie(config)];
      const authorize: LiveAccess = bearer
        ? Effect.void
        : auth
            .valid(cookie)
            .pipe(
              Effect.flatMap((valid) =>
                valid ? Effect.void : Effect.fail(new DashboardUnauthorized()),
              ),
            );
      return subscribe(authorize).pipe(
        Stream.map(({ revision, value }) =>
          value._tag === "Success"
            ? { type: "snapshot" as const, revision, value: value.success }
            : { type: "failure" as const, revision, error: value.failure },
        ),
        Stream.merge(
          Stream.tick("15 seconds").pipe(Stream.map(() => ({ type: "heartbeat" as const }))),
        ),
        Stream.mapEffect((snapshot) =>
          Effect.gen(function* () {
            yield* authorize;
            return snapshot;
          }),
        ),
      );
    });
  const subscribe = <A, E>(read: Effect.Effect<A, E>) =>
    secureLive((authorize) =>
      reactivity.subscribe(authorize.pipe(Effect.andThen(Effect.result(read)))),
    );

  const toolInputs = (appId: AppId) =>
    Effect.gen(function* () {
      const { app, accounts: selections } = yield* resolved(appId);
      const ids = [...new Set(invocationEntries(selections).flatMap(([, used]) => used))];
      const accounts = yield* Effect.forEach(ids, (id) =>
        Effect.gen(function* () {
          const account = yield* executor.accounts
            .get({ account: id })
            .pipe(Effect.catchTag("AccountNotFound", () => Effect.succeed(null)));
          if (account === null) return null;
          const state = yield* executor.accounts.signIn({ account: id });
          return {
            id: account.id,
            provider: account.provider,
            method: account.method,
            credentials: state.credentialsFingerprint,
            reconnect: state.state === "reconnect",
          };
        }),
      );
      return { version: app.activeVersion, selections, accounts };
    });
  const toolIndex = (app: AppId) =>
    resolved(app).pipe(
      Effect.flatMap(({ accounts }) => executor.tools.index({ app, accounts })),
      Effect.map((index) => ({ tools: index.items, routers: index.routers })),
      Effect.timeoutOrElse({
        duration: config.mcp.timeoutMs,
        orElse: () => Effect.fail(new ToolDiscoveryTimedOut({ app })),
      }),
    );

  const handlers = HttpApiBuilder.group(DashboardApi, "dashboard", (handlers) =>
    handlers
      .handle("mcpInstallation", () =>
        Effect.gen(function* () {
          const request = yield* localRequest(config.port, config.browserOrigin).pipe(
            Effect.mapError(() => new DashboardForbidden()),
          );
          return {
            endpoint: HttpUrl.make(new URL("/mcp", requestOrigin(config, request)).href),
          };
        }),
      )
      .handle("liveOverview", () => subscribe(overview))
      .handle("liveApp", ({ params }) => subscribe(appDetail(params.app)))
      .handle("liveAccount", ({ params }) => subscribe(accountDetail(params.account)))
      .handle("liveTools", ({ params }) =>
        secureLive((authorize) =>
          reactivity
            .subscribe(authorize.pipe(Effect.andThen(Effect.result(toolInputs(params.app)))))
            .pipe(
              Stream.changesWith(
                (left, right) => JSON.stringify(left.value) === JSON.stringify(right.value),
              ),
              Stream.mapEffect(({ revision, value }) =>
                Effect.gen(function* () {
                  yield* authorize;
                  const result =
                    value._tag === "Failure"
                      ? Result.fail(value.failure)
                      : yield* Effect.result(toolIndex(params.app));
                  return { revision, value: result };
                }),
              ),
            ),
        ),
      )
      .handle("overview", () => overview)
      .handle("ownerMigration", () => ownerMigration)
      .handle("app", ({ params }) => appDetail(params.app))
      .handle("appIcon", ({ params }) =>
        executor.apps.get({ app: params.app }).pipe(Effect.flatMap(uiIcon)),
      )
      .handle("appList", ({ params }) =>
        executor.apps
          .get(params)
          .pipe(Effect.flatMap((app) => appAccountLinks(sql, executor, app, "app"))),
      )
      .handle("appGet", ({ params }) =>
        appAccountRequirement(sql, executor, { ...params, scope: "app" }),
      )
      .handle("appLink", ({ params }) =>
        changeLinks(
          params.app,
          linkAccount(sql, executor, { ...params, scope: "app" }).pipe(
            Effect.tap(() => wakeWebhookSources),
          ),
        ),
      )
      .handle("appUnlink", ({ params }) =>
        changeLinks(
          params.app,
          unlinkAccount(sql, executor, { ...params, scope: "app" }).pipe(
            Effect.tap(() => wakeWebhookSources),
          ),
        ),
      )
      .handle("appConnect", ({ params, payload }) => connectWithFields(params, "app", payload))
      .handle("appConnectOAuth", ({ params, payload }) => connectWithOAuth(params, "app", payload))
      .handle("userList", ({ params }) =>
        executor.apps
          .get(params)
          .pipe(Effect.flatMap((app) => appAccountLinks(sql, executor, app, "user"))),
      )
      .handle("userGet", ({ params }) =>
        appAccountRequirement(sql, executor, { ...params, scope: "user" }),
      )
      .handle("userLink", ({ params }) =>
        changeLinks(
          params.app,
          linkAccount(sql, executor, { ...params, scope: "user" }).pipe(
            Effect.tap(() => wakeWebhookSources),
          ),
        ),
      )
      .handle("userUnlink", ({ params }) =>
        changeLinks(
          params.app,
          unlinkAccount(sql, executor, { ...params, scope: "user" }).pipe(
            Effect.tap(() => wakeWebhookSources),
          ),
        ),
      )
      .handle("userConnect", ({ params, payload }) => connectWithFields(params, "user", payload))
      .handle("userConnectOAuth", ({ params, payload }) =>
        connectWithOAuth(params, "user", payload),
      )
      .handle("renameApp", ({ params, payload }) =>
        params.app === managedApp
          ? Effect.fail(new AppRenameBlocked(params))
          : executor.apps.rename({ ...params, ...payload }),
      )
      .handle("deleteApp", ({ params }) =>
        params.app === managedApp
          ? Effect.fail(new AppDeletionBlocked(params))
          : executor.apps.remove(params),
      )
      .handle("source", ({ params }) => executor.apps.source(params))
      .handle("sourceDisplay", ({ params }) =>
        executor.apps.source(params).pipe(Effect.flatMap(sourceDisplay)),
      )
      .handle("sourceDisplayFile", ({ params, query }) =>
        executor.apps
          .source(params)
          .pipe(Effect.flatMap((source) => sourceDisplayFile(source.files, query.path))),
      )
      .handle("catalog", () => appCatalog.list)
      .handle("importApp", ({ payload }) =>
        Effect.gen(function* () {
          const existing = yield* executor.apps.list({ owner, name: payload.name });
          if (existing.length > 0) return yield* new AppNameTaken({ owner, name: payload.name });
          const generated = yield* appCatalog.prepare(payload);
          if (generated.origin !== undefined)
            return yield* executor.apps
              .copy({
                from: { files: generated.files, origin: generated.origin, activation: "deploy" },
                owner,
                name: payload.name,
              })
              .pipe(
                Effect.catchTags({
                  RegistryError: Effect.die,
                  VersionNotFound: Effect.die,
                  AppNotDeployed: Effect.die,
                }),
                Effect.flatMap(deployedCopy),
              );
          const { app } = yield* executor.apps.deploy({
            owner,
            name: payload.name,
            files: generated.files,
          });
          return app;
        }),
      )
      .handle("account", ({ params }) => accountDetail(params.account))
      .handle("checkAccount", ({ params }) =>
        linkedApps(params.account).pipe(
          Effect.flatMap((apps) =>
            executor.accounts.check({ ...params, apps: apps.map((app) => app.id) }),
          ),
        ),
      )
      .handle("checkCredentials", ({ params, payload }) =>
        executor.apps.checkCredentials({ ...params, ...payload }),
      )
      .handle("updateAccount", ({ params, payload }) =>
        manage(params.account, executor.accounts.update({ ...params, ...payload })),
      )
      .handle("disconnectAccount", ({ params }) =>
        manage(
          params.account,
          Effect.gen(function* () {
            const [first, ...rest] = yield* appLinkApps(sql, executor, params.account);
            if (first !== undefined)
              return yield* new AccountLinkedToApp({
                account: params.account,
                apps: [first, ...rest],
              });
            return yield* executor.accounts.remove(params);
          }),
        ),
      )
      .handle("importCustomApp", ({ payload }) =>
        Effect.gen(function* () {
          const input = payload.source;
          const existing = yield* executor.apps.list({ owner, name: input.name });
          if (existing.length > 0) return yield* new AppNameTaken({ owner, name: input.name });
          const generated = yield* appCatalog.custom(input);
          const { app } = yield* executor.apps.deploy({
            owner,
            name: input.name,
            files: generated.files,
          });
          return app;
        }),
      )
      .handle("oauthSetup", ({ payload }) =>
        Effect.gen(function* () {
          const request = yield* localRequest(config.port, config.browserOrigin).pipe(
            Effect.mapError(() => new DashboardForbidden()),
          );
          return yield* connectOptions(executor, {
            ...payload,
            owner,
            redirectUri: new URL(OAuthCallbackPath, requestOrigin(config, request)).href,
          });
        }),
      )
      .handle("completeOAuth", ({ payload }) =>
        executor.accountConnections.findOAuth(payload).pipe(
          Effect.flatMap((connection) =>
            executor.accountConnections.completeOAuth({
              connection: connection.id,
              callbackUrl: payload.callbackUrl,
            }),
          ),
          Effect.tap(() => wakeWebhookSources),
        ),
      )
      .handle("runTool", ({ params, payload }) =>
        Effect.andThen(browserOnly(config, auth), resolved(params.app)).pipe(
          Effect.flatMap(({ accounts }) =>
            executor.tools.call({ ...params, ...payload, accounts }, { issuer: dashboardRun }),
          ),
          Effect.map((result): BrowserToolRun =>
            result.status === "approval-required"
              ? { status: result.status, requestId: result.requestId }
              : { status: result.status, value: result.value },
          ),
        ),
      )
      .handle("toolApproval", ({ params }) =>
        reviewedTool(params.app, params.requestId).pipe(
          Effect.map(({ invocation, expiresAt, appName }): BrowserApprovalView => ({
            status: "pending",
            appName,
            request: {
              status: "approval-required",
              requestId: params.requestId,
              invocation,
              elicitation: approvalElicitation(invocation.tool, invocation.input),
              expiresAt,
            },
          })),
          Effect.catchTag("ToolApprovalNotFound", () =>
            Effect.succeed({ status: "unavailable" as const }),
          ),
        ),
      )
      .handle("answerToolApproval", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* reviewedTool(params.app, params.requestId);
          const response = yield* Schema.decodeUnknownEffect(ApprovalResponse)(
            payload.response,
          ).pipe(Effect.mapError(() => new RequestInvalid()));
          const result = yield* executor.tools.resume(
            { requestId: params.requestId, owner, response },
            { issuer: dashboardRun },
          );
          return result.status === "already-consumed" ||
            (result.status === "failed" && result.reason === "expired")
            ? { status: "unavailable" as const }
            : { status: "answered" as const, result };
        }).pipe(
          Effect.catchTag("ToolApprovalNotFound", () =>
            Effect.succeed({ status: "unavailable" as const }),
          ),
        ),
      )
      .handle("tools", ({ params, query }) =>
        resolved(params.app).pipe(
          Effect.flatMap(({ accounts }) => executor.tools.list({ ...params, ...query, accounts })),
          Effect.timeoutOrElse({
            duration: config.mcp.timeoutMs,
            orElse: () => Effect.fail(new ToolDiscoveryTimedOut(params)),
          }),
        ),
      )
      .handle("tool", ({ params, query }) =>
        resolved(params.app).pipe(
          Effect.flatMap(({ accounts }) => executor.tools.get({ ...params, ...query, accounts })),
          Effect.timeoutOrElse({
            duration: config.mcp.timeoutMs,
            orElse: () => Effect.fail(new ToolDiscoveryTimedOut({ app: params.app })),
          }),
        ),
      ),
  );
  return {
    handlers: Layer.mergeAll(handlers, localResourceHandlers(executor, sql, wakeWebhookSources)),
    access,
  };
};
