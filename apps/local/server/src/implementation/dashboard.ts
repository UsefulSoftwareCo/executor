import { sourceDisplay, sourceDisplayFile } from "@executor-js/app-management/source-display";
import { localResourceHandlers } from "./resources.ts";
import { localProfileHandlers } from "./profiles.ts";
import { appOrigin } from "../contracts/app-ui.ts";
/** Product projections over the existing SDK and retained deployment storage. */
import {
  Provider,
  StorageError,
  OwnerId,
  AppNameTaken,
  HttpUrl,
  type AppId,
  type ProfileId,
  type AccountId,
  type ExecutorDatabase,
  type Cursor,
  type DeploymentId,
  type Tool,
  type Credentials,
  type Executor,
} from "@executor-js/sdk/core";
import { Effect, Layer, Redacted, Result, Schema, Stream } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { localRequest, requestOrigin, sessionCookie, type LocalAuth } from "./auth.ts";
import { createCatalog, type CatalogSource } from "@executor-js/catalog";
import type { HostEgress } from "@executor-js/utils/url-policy";
import type { AuthStorageError } from "../contracts/auth.ts";
import type { ServerConfig } from "../contracts/config.ts";
import { accountSignIn } from "./account-status.ts";
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
  AccountManagementBlocked,
  ToolCatalogChanged,
} from "../contracts/dashboard.ts";

/** Authenticate local browser and bearer requests using the same session boundary. */
export const dashboardAccess = (config: ServerConfig, auth: LocalAuth) =>
  Layer.succeed(DashboardAccess, (response) =>
    Effect.gen(function* () {
      const request = yield* localRequest(config.port, config.browserOrigin).pipe(
        Effect.mapError(() => new DashboardForbidden()),
      );
      const bearer = request.headers.authorization === `Bearer ${Redacted.value(config.apiKey)}`;
      const session = yield* auth.valid(request.cookies[sessionCookie(config.port)]);
      if (!bearer && !session) return yield* Effect.fail(new DashboardUnauthorized());
      return (yield* response).pipe(HttpServerResponse.setHeader("cache-control", "no-store"));
    }),
  );

/** Serve authenticated read endpoints without granting browser access to SDK mutations. */
export const dashboard = (
  executor: Executor,
  storage: ExecutorDatabase,
  credentials: Credentials,
  config: ServerConfig,
  auth: LocalAuth,
  egress: HostEgress,
  {
    catalog,
    managedApp,
    managedAccount,
  }: {
    readonly catalog?: CatalogSource;
    readonly managedApp?: AppId;
    readonly managedAccount?: AccountId;
  } = {},
) => {
  const owner = OwnerId.make("local");
  const appCatalog = createCatalog(egress, catalog);
  const db = storage.orm("4.0.0");
  const signIn = accountSignIn(storage, credentials);
  const query = <A, E>(work: () => Effect.Effect<A, E>) =>
    Effect.suspend(work).pipe(Effect.mapError(() => new StorageError()));
  const manage = <A, E, R>(account: AccountId, operation: Effect.Effect<A, E, R>) =>
    account === managedAccount ? Effect.fail(new AccountManagementBlocked({ account })) : operation;
  const access = dashboardAccess(config, auth);
  // Database reads infer dependencies in the shared storage service, including reads in SDK calls.
  const overview = Effect.gen(function* () {
    const { apps, accounts, providers } = yield* Effect.all(
      {
        apps: executor.apps.list(),
        accounts: executor.accounts.list(),
        providers: query(() => db.findMany("providers", {})).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Provider))),
          Effect.mapError(() => new StorageError()),
        ),
      },
      { concurrency: 3 },
    );
    const definitions = new Map(providers.map((provider) => [provider.id, provider.definition]));
    const display = [];
    for (const account of accounts) {
      const definition = definitions.get(account.provider);
      if (definition === undefined) return yield* Effect.fail(new StorageError());
      display.push({
        ...account,
        providerName: definition.name,
        providerUrl: providerDisplayUrl(definition),
        signIn: yield* signIn(account, definition),
      });
    }
    const profiles = (yield* Effect.forEach(apps, (app) =>
      executor.apps.profiles
        .list({ app: app.id, subject: "local" })
        .pipe(Effect.mapError(() => new StorageError())),
    )).flat();
    return { apps, accounts: display, profiles };
  });
  const appDetail = (appId: AppId) =>
    Effect.gen(function* () {
      const app = yield* executor.apps.get({ app: appId });
      const deployments = yield* executor.apps.deployments({ app: appId });
      const source =
        app.activeDeployment === null
          ? null
          : yield* executor.apps.source({ app: appId }).pipe(
              Effect.catchTags({
                DeploymentNotFound: () => new StorageError(),
                AppNotDeployed: () => new StorageError(),
              }),
            );
      return {
        app,
        uiUrl:
          source !== null && source.files.some((file) => file.path === "ui/index.html")
            ? HttpUrl.make(appOrigin(app.id, config.port))
            : null,
        canDelete: app.id !== managedApp,
        deployments,
      };
    });
  const accountDetail = (accountId: AccountId) =>
    Effect.gen(function* () {
      const account = yield* executor.accounts.get({ account: accountId });
      const row = yield* query(() =>
        db.findFirst("providers", { where: (b) => b("id", "=", account.provider) }),
      );
      const provider = yield* Schema.decodeUnknownEffect(Provider)(row).pipe(
        Effect.mapError(() => new StorageError()),
      );
      const apps = yield* executor.apps.list({ account: account.id });
      return {
        account: {
          ...account,
          providerName: provider.definition.name,
          providerUrl: providerDisplayUrl(provider.definition),
          signIn: yield* signIn(account, provider.definition),
        },
        provider,
        apps,
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
      const bearer = request.headers.authorization === `Bearer ${Redacted.value(config.apiKey)}`;
      const cookie = request.cookies[sessionCookie(config.port)];
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
            // Idle sessions are rechecked too; a revoked browser session cannot retain a subscription.
            yield* authorize;
            return snapshot;
          }),
        ),
      );
    });
  const subscribe = <A, E>(read: Effect.Effect<A, E>) =>
    secureLive((authorize) =>
      storage.reactivity.subscribe(authorize.pipe(Effect.andThen(Effect.result(read)))),
    );

  // Only this app's execution inputs can trigger expensive upstream discovery. The cheap
  // tracked query may rerun after any account write, but credentials never enter a response.
  const toolInputs = (appId: AppId, profile?: ProfileId) =>
    Effect.gen(function* () {
      const app = yield* executor.apps.get({ app: appId });
      const selected =
        profile === undefined
          ? undefined
          : yield* executor.apps.profiles.get({ app: appId, profile });
      const bindings = selected?.accounts ?? {};
      const ids = [
        ...new Set(
          Object.values(bindings).flatMap((selection) =>
            typeof selection === "string" ? [selection] : selection,
          ),
        ),
      ];
      const accounts = yield* Effect.forEach(ids, (id) =>
        Effect.gen(function* () {
          const account = yield* query(() =>
            db.findFirst("accounts", { where: (b) => b("id", "=", id) }),
          );
          const grant = yield* query(() =>
            db.findFirst("oauthGrants", { where: (b) => b("id", "=", id) }),
          );
          return account === null
            ? null
            : {
                id: account.id,
                provider: account.provider,
                method: account.method,
                encryptedCredentials: Array.from(account.encryptedCredentials),
                reconnect: grant?.status === "reconnect",
              };
        }),
      );
      return {
        deployment: app.activeDeployment,
        selections: bindings,
        accounts,
        profile: selected,
      };
    });
  const allTools = (app: AppId, profile?: ProfileId, expectedProfileRevision?: number) =>
    Effect.gen(function* () {
      let cursor: Cursor | undefined;
      let deployment: DeploymentId | undefined;
      const cursors = new Set<Cursor>();
      const tools: Tool[] = [];
      do {
        const page = yield* executor.tools.list({
          app,
          profile,
          expectedProfileRevision,
          limit: 2_000,
          ...(cursor === undefined ? {} : { cursor }),
          ...(deployment === undefined ? {} : { deployment }),
        });
        if (deployment !== undefined && page.deployment !== deployment)
          return yield* new ToolCatalogChanged({ app });
        deployment = page.deployment;
        tools.push(...page.items);
        cursor = page.next;
        if (cursor !== undefined) {
          if (cursors.has(cursor)) return yield* new ToolCatalogChanged({ app });
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      return { tools };
    }).pipe(
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
      .handle("liveTools", ({ params, query }) =>
        secureLive((authorize) =>
          storage.reactivity
            .subscribe(
              authorize.pipe(Effect.andThen(Effect.result(toolInputs(params.app, query.profile)))),
            )
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
                      : yield* Effect.result(
                          allTools(params.app, query.profile, query.expectedProfileRevision),
                        );
                  return { revision, value: result };
                }),
              ),
            ),
        ),
      )
      .handle("overview", () => overview)
      .handle("app", ({ params }) => appDetail(params.app))
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
          const { app } = yield* executor.apps.deploy({
            owner,
            name: payload.name,
            files: generated.files,
          });
          return { ...app, skippedOperations: generated.skippedOperations };
        }),
      )
      .handle("addAccount", ({ payload }) => executor.accounts.add({ owner, ...payload }))
      .handle("account", ({ params }) => accountDetail(params.account))
      .handle("renameAccount", ({ params, payload }) =>
        manage(params.account, executor.accounts.update({ ...params, ...payload })),
      )
      .handle("replaceAccountCredentials", ({ params, payload }) =>
        manage(params.account, executor.accounts.replaceCredentials({ ...params, ...payload })),
      )
      .handle("disconnectAccount", ({ params }) =>
        manage(params.account, executor.accounts.remove(params)),
      )
      .handle("reconnectAccount", ({ params, payload }) =>
        manage(
          params.account,
          Effect.gen(function* () {
            const request = yield* localRequest(config.port, config.browserOrigin).pipe(
              Effect.mapError(() => new DashboardForbidden()),
            );
            const account = yield* executor.accounts.get(params);
            const connection = yield* executor.accountConnections.create({
              account: account.id,
              owner: account.owner,
              provider: account.provider,
            });
            const signIn = yield* executor.accountConnections.startOAuth({
              connection: connection.id,
              method: account.method,
              label: account.label,
              ...payload,
              redirectUri: new URL(OAuthCallbackPath, requestOrigin(config, request)).href,
            });
            return { ...signIn, connection: connection.id };
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
          return { ...app, skippedOperations: generated.skippedOperations };
        }),
      )
      .handle("oauthSetup", ({ payload }) =>
        Effect.gen(function* () {
          const request = yield* localRequest(config.port, config.browserOrigin).pipe(
            Effect.mapError(() => new DashboardForbidden()),
          );
          return yield* executor.accountConnections.oauthSetup({
            ...payload,
            owner,
            redirectUri: new URL(OAuthCallbackPath, requestOrigin(config, request)).href,
          });
        }),
      )
      .handle("startOAuth", ({ payload }) =>
        Effect.gen(function* () {
          const request = yield* localRequest(config.port, config.browserOrigin).pipe(
            Effect.mapError(() => new DashboardForbidden()),
          );
          const connection = yield* executor.accountConnections.create({
            provider: payload.provider,
            owner,
          });
          const signIn = yield* executor.accountConnections.startOAuth({
            ...payload,
            connection: connection.id,
            redirectUri: new URL(OAuthCallbackPath, requestOrigin(config, request)).href,
          });
          return { ...signIn, connection: connection.id };
        }),
      )
      .handle("completeOAuth", ({ payload }) => executor.accountConnections.completeOAuth(payload))
      .handle("tools", ({ params, query }) =>
        executor.tools.list({ ...params, ...query }).pipe(
          Effect.timeoutOrElse({
            duration: config.mcp.timeoutMs,
            orElse: () => Effect.fail(new ToolDiscoveryTimedOut(params)),
          }),
        ),
      ),
  );
  return {
    handlers: Layer.mergeAll(
      handlers,
      localProfileHandlers(executor),
      localResourceHandlers(executor),
    ),
    access,
  };
};
