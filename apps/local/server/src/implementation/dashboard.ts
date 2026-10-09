import { sourceDisplay, sourceDisplayFile } from "@executor-js/app-management/source-display";
import { localResourceHandlers } from "./resources.ts";
import { localProfileHandlers } from "./profiles.ts";
import { appOrigin } from "../contracts/app-ui.ts";
/** Product projections over the existing SDK and retained deployment storage. */
import {
  StorageError,
  OwnerId,
  AppNameTaken,
  HttpUrl,
  RequestInvalid,
  ToolApprovalIssuer,
  ToolApprovalNotFound,
  type AppId,
  type ApprovalRequestId,
  type ProfileId,
  type AccountId,
  type ExecutorDatabase,
  type Cursor,
  type DeploymentId,
  type Tool,
  type ToolRouter,
  type Executor,
} from "@executor-js/sdk/core";
import { Effect, Layer, Redacted, Result, Schema, Stream } from "effect";
import { ApprovalResponse, approvalElicitation } from "apps/contracts";
import {
  ToolRunApprovalRefused,
  type BrowserApprovalView,
  type BrowserToolRun,
} from "@executor-js/mcp/browser";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { localRequest, requestOrigin, sessionCookie, type LocalAuth } from "./auth.ts";
import { createCatalog, type CatalogSource } from "@executor-js/catalog";
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
  AccountManagementBlocked,
  ToolCatalogChanged,
  type AppAccountTarget,
} from "../contracts/dashboard.ts";

/** A person's own decisions come from their paired browser, never from the API key. */
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
/**
 * The paired browser's own runs. Their approvals are saved with this issuer, so only the dashboard
 * can read or answer them; MCP, schedules and `/v1/tools/call` save no issuer.
 */
const dashboardRun = ToolApprovalIssuer.make("dashboard");
/** Authenticate local browser and bearer requests using the same session boundary. */
export const dashboardAccess = (config: ServerConfig, auth: LocalAuth) =>
  Layer.succeed(DashboardAccess, (response) =>
    Effect.gen(function* () {
      const request = yield* localRequest(config.port, config.browserOrigin).pipe(
        Effect.mapError(() => new DashboardForbidden()),
      );
      const bearer = request.headers.authorization === `Bearer ${Redacted.value(config.apiKey)}`;
      const session = yield* auth.valid(request.cookies[sessionCookie(config)]);
      if (!bearer && !session) return yield* Effect.fail(new DashboardUnauthorized());
      return (yield* response).pipe(HttpServerResponse.setHeader("cache-control", "no-store"));
    }),
  );

/** Serve authenticated read endpoints without granting browser access to SDK mutations. */
export const dashboard = (
  executor: Executor,
  reactivity: ExecutorDatabase["reactivity"],
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
  const appCatalog = createCatalog(
    { egress, clientMetadataUrl: config.oauthClientMetadataUrl },
    catalog,
  );
  /** Only status and a non-refreshable expiry leave the trusted host. */
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
  /**
   * Every dashboard sign-in fills an app requirement; completing it selects the account there. A
   * reconnect names the account, which the local server's own account cannot be.
   */
  const appConnection = (app: AppId, target: typeof AppAccountTarget.Type) =>
    target.account === undefined
      ? executor.accountConnections.create({
          owner,
          target: { app, profile: target.profile, requirement: target.requirement },
        })
      : manage(
          target.account,
          executor.accountConnections.create({
            owner,
            account: target.account,
            target: { app, profile: target.profile, requirement: target.requirement },
          }),
        );
  const access = dashboardAccess(config, auth);
  /** Only the dashboard's own runs are reviewed here. The arguments shown and resumed are the saved invocation's. */
  const reviewedTool = (app: AppId, requestId: ApprovalRequestId) =>
    Effect.gen(function* () {
      yield* browserOnly(config, auth);
      const pending = yield* executor.tools.approval({ requestId, owner });
      // MCP, scheduled and API approvals are answered only in their own flow.
      if (pending.issuer !== dashboardRun)
        return yield* new ToolRunApprovalRefused({
          reason: pending.issuer === undefined ? "unrecorded" : "another-person",
        });
      if (pending.invocation.app !== app) return yield* new ToolApprovalNotFound({ requestId });
      const found = yield* executor.apps.get({ app });
      return { ...pending, appName: found.name };
    });
  // Database reads infer dependencies in the shared storage service, including reads in SDK calls.
  const overview = Effect.gen(function* () {
    const { apps, accounts, health, providers } = yield* Effect.all(
      {
        apps: executor.apps.list(),
        accounts: executor.accounts.list(),
        health: executor.accounts.listHealth(),
        providers: executor.accounts.providers(),
      },
      { concurrency: 4 },
    );
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
      const provider = yield* executor.accounts
        .provider({ account: accountId })
        .pipe(Effect.catchTag("ProviderNotFound", () => new StorageError()));
      const apps = yield* executor.apps.list({ account: account.id });
      const health = yield* executor.accounts.health({ account: account.id });
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
            // Idle sessions are rechecked too; a revoked browser session cannot retain a subscription.
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
      // The fingerprint stands in for the credential bytes: any credential write changes it, so the
      // catalog is listed again exactly when its inputs changed.
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
      // Every page lists the whole catalog's routers.
      let routers: readonly ToolRouter[] = [];
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
        routers = page.routers;
        cursor = page.next;
        if (cursor !== undefined) {
          if (cursors.has(cursor)) return yield* new ToolCatalogChanged({ app });
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      return { tools, routers };
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
          reactivity
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
          return app;
        }),
      )
      .handle("account", ({ params }) => accountDetail(params.account))
      .handle("checkAccount", ({ params }) => executor.accounts.check(params))
      .handle("checkCredentials", ({ params, payload }) =>
        executor.apps.checkCredentials({ ...params, ...payload }),
      )
      .handle("updateAccount", ({ params, payload }) =>
        manage(params.account, executor.accounts.update({ ...params, ...payload })),
      )
      .handle("disconnectAccount", ({ params }) =>
        manage(params.account, executor.accounts.remove(params)),
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
          return yield* executor.accountConnections.oauthSetup({
            ...payload,
            owner,
            redirectUri: new URL(OAuthCallbackPath, requestOrigin(config, request)).href,
          });
        }),
      )
      .handle("connectAccount", ({ params, payload: { method, label, fields, ...target } }) =>
        Effect.gen(function* () {
          const connection = yield* appConnection(params.app, target);
          return yield* executor.accountConnections.submit({
            connection: connection.id,
            method,
            ...(label === undefined ? {} : { label }),
            fields,
          });
        }),
      )
      .handle("startOAuth", ({ params, payload: { method, label, client, ...target } }) =>
        Effect.gen(function* () {
          const request = yield* localRequest(config.port, config.browserOrigin).pipe(
            Effect.mapError(() => new DashboardForbidden()),
          );
          const connection = yield* appConnection(params.app, target);
          const signIn = yield* executor.accountConnections.startOAuth({
            connection: connection.id,
            method,
            ...(label === undefined ? {} : { label }),
            ...(client === undefined ? {} : { client }),
            redirectUri: new URL(OAuthCallbackPath, requestOrigin(config, request)).href,
          });
          return { ...signIn, connection: connection.id };
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
        ),
      )
      // The paired browser is the person running the tool, so approval waits for their review.
      .handle("runTool", ({ params, payload }) =>
        Effect.andThen(
          browserOnly(config, auth),
          executor.tools.call({ ...params, ...payload }, { issuer: dashboardRun }),
        ).pipe(
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
              // Built from the saved call, so the prompt shows exactly what approval resumes.
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
          // The SDK checks the issuer again before it consumes the request.
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
