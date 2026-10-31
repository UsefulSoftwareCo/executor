import { AccountProvisioned } from "@executor-js/sdk/core";
import {
  InteractiveRetirementBusy,
  InteractiveRetirementFailed,
  InteractiveReconnectUnsupported,
} from "@executor-js/sdk";
import {
  blockedRecovery,
  LocalOwnerMigration,
} from "@executor-js/app-management/contracts/local-owners";
import {
  VersionDisplay,
  SourceDisplayFile,
  SourceDisplayFileQuery,
} from "@executor-js/app-management/contracts/source-display";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { DashboardAppBrowser } from "./app-browser.ts";
import { DashboardWorkflows, DashboardWebhooks } from "./resources.ts";
import { RequestRejection } from "@executor-js/sdk/core";
import { AccountChoiceUnsupported, ToolKind, ToolKindMismatch } from "@executor-js/sdk/core";
import { AppWorkflowsActive, AccountWorkflowsActive } from "@executor-js/sdk/core";
import { DashboardSchedules } from "./schedules.ts";
import { DashboardMcpConnections } from "./mcp-connections.ts";
import { AccountWebhooksActive } from "@executor-js/sdk/core";
import { AppWebhooksActive } from "@executor-js/sdk/core";
/** Browser-safe read contracts for inspecting the local Executor instance. */
import {
  AccountConnectionTargetChanged,
  AccountConnectionRefused,
  AccountScope,
  AccountConnectionNotFound,
  AccountConnectionClosed,
  Account,
  AccountHealth,
  AccountRevocation,
  CredentialCheck,
  AccountNotFound,
  AccountRequired,
  AccountSelectionInvalid,
  App,
  AppNotDeployed,
  AppEvaluationFailed,
  ToolListingTimedOut,
  AppProviderFailed,
  AppId,
  AppName,
  AppNotFound,
  AppVersionChanged,
  CredentialsError,
  Cursor,
  Version,
  VersionId,
  VersionNotFound,
  OwnerId,
  PageLimit,
  StorageError,
  sourceErrors,
  ToolPage,
  AccountFieldsInput,
  ProviderId,
  AuthMethodName,
  AccountFieldsInvalid,
  AuthMethodInvalid,
  ProviderNotFound,
  AppNameTaken,
  AppSlugTaken,
  VersionBuildFailed,
  BuildMemoryExceeded,
  SkillDefinitionInvalid,
  OAuthClientSelection,
  OAuthClientNotFound,
  OAuthConnectOptions,
  OAuthClientUnavailable,
  OAuthCompletionFailed,
  OAuthSetupFailed,
  OAuthReconnectRequired,
  OAuthRenewalFailed,
  HttpUrl,
  Provider,
  AccountId,
  DeployedApp,
  Tool,
  ToolName,
  ToolRouter,
  ToolSummary,
  Json,
  ToolNotFound,
  InputInvalid,
  ToolCallFailed,
  ToolElicitationFailed,
  ToolBlocked,
  ToolApprovalRequired,
  ApprovalRequestId,
  ToolPolicyFailed,
  RequestInvalid,
  type ProviderDefinition,
} from "@executor-js/sdk";
import {
  CatalogEntry,
  CatalogImportFailed,
  CatalogUnavailable,
  CatalogImport,
  CustomAppInput,
} from "@executor-js/catalog/contracts";
import {
  BrowserApprovalAnswer,
  BrowserApprovalView,
  BrowserToolRun,
  BrowserToolRunAnswer,
  ToolRunApprovalRefused,
} from "@executor-js/mcp/browser";
import { ConnectionSignIn } from "./account-connections.ts";
import { RequirementMismatch } from "./requirement-mismatch.ts";
import { AuthStorageError } from "./auth.ts";
import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  OpenApi,
} from "effect/http-api";

/** Why the last start did not move other owners' records to `local`; see data step 7. */
export { blockedRecovery, LocalOwnerMigration };

/** Same callback path as Executor local, cloud and self-host; the host supplies its origin. */
export const OAuthCallbackPath = "/api/oauth/callback";

/** The browser has no active local session. */
export const DashboardUnauthorized = UserFacingError.define({
  tag: "DashboardUnauthorized",
  status: 401,
  title: "Browser pairing required",
  description: "This browser is not paired with this Executor instance.",
  recovery: {
    action: "Run executor pair and open the new link, then return to account setup.",
    instructions:
      "Restore local browser pairing with executor pair and guide the user through the new pairing link. Then reopen the intended app’s account setup. Keep pairing credentials private and preserve pairing authorization.",
  },
});
/** Parsed DashboardUnauthorized failure. */
export type DashboardUnauthorized = typeof DashboardUnauthorized.Type;
/** Browser calls must originate from this exact loopback server. */
export const DashboardForbidden = UserFacingError.define({
  tag: "DashboardForbidden",
  status: 403,
  title: "Dashboard access denied",
  description: "This browser cannot use the current dashboard address.",
  recovery: {
    action: "Open Executor directly at its local dashboard address and return to account setup.",
    instructions:
      "Check the local Executor dashboard origin and open its supported address directly. Correct a stale or unsupported browser origin. Preserve host and origin validation; do not loosen dashboard access checks.",
  },
});
/** Parsed DashboardForbidden failure. */
export type DashboardForbidden = typeof DashboardForbidden.Type;
/** Live app inspection exceeded the host's discovery timeout. */
export class ToolDiscoveryTimedOut extends Schema.TaggedError<ToolDiscoveryTimedOut>()(
  "ToolDiscoveryTimedOut",
  { app: AppId },
  {
    httpApiStatus: 504,
    description: "The app took too long to list its tools. Try refreshing the catalog.",
  },
) {}
/** The local management app is installed and maintained by this server. */
export class AppDeletionBlocked extends Schema.TaggedError<AppDeletionBlocked>()(
  "AppDeletionBlocked",
  { app: AppId },
  {
    httpApiStatus: 409,
    description: "This app is managed by the local server and cannot be deleted.",
  },
) {}
/** The server maintains the bundled app's name across restarts. */
export class AppRenameBlocked extends Schema.TaggedError<AppRenameBlocked>()(
  "AppRenameBlocked",
  { app: AppId },
  {
    httpApiStatus: 409,
    description: "This app is managed by the local server and cannot be renamed.",
  },
) {}
/**
 * The server links its own Executor app to the account it manages each time it starts, and that
 * app's tools need the link. Nothing else links, unlinks, replaces or connects its accounts.
 */
export const AppAccountLinksBlocked = UserFacingError.define({
  tag: "AppAccountLinksBlocked",
  status: 409,
  fields: { app: AppId },
  title: "This app's account is managed by Executor",
  description:
    "The local server links this app's account itself each time it starts, and its tools need that link. Its account links can't be changed.",
  recovery: {
    action: "Leave this app's account as it is.",
    instructions:
      "Do not link, unlink, replace or connect accounts for the local Executor app. The server keeps its own account linked; use the Executor tools as they are.",
  },
});
/** Parsed AppAccountLinksBlocked failure. */
export type AppAccountLinksBlocked = typeof AppAccountLinksBlocked.Type;
/** The server's own API connection is managed at the host boundary. */
export class AccountManagementBlocked extends Schema.TaggedError<AccountManagementBlocked>()(
  "AccountManagementBlocked",
  { account: AccountId },
  {
    httpApiStatus: 409,
    description: "This account is managed by the local server and cannot be changed here.",
  },
) {}

/** The account is linked to apps for every call; it cannot be deleted until it is unlinked. */
export const AccountLinkedToApp = UserFacingError.define({
  tag: "AccountLinkedToApp",
  status: 409,
  fields: { account: AccountId, apps: Schema.NonEmptyArray(AppId) },
  title: "This account is linked to an app for everyone",
  description: "An app uses this account as its own, so it can't be deleted while it is linked.",
  recovery: {
    action: "Unlink the account under App accounts on each app's Accounts tab, then delete it.",
    instructions:
      "Read the app accounts of each named app and unlink this account from them. Link a replacement first if the app still needs one. Then delete the account.",
  },
});
/** Parsed AccountLinkedToApp failure. */
export type AccountLinkedToApp = typeof AccountLinkedToApp.Type;

/** One account linked to one of the app's requirements, with its checks by this app. */
export const AppAccountLink = Schema.Struct({
  requirement: Schema.NonEmptyString,
  account: Account,
  createdAt: Schema.Date,
  health: Schema.optionalKey(AccountHealth),
});
export type AppAccountLink = typeof AppAccountLink.Type;

/** One account a requirement lists: linked to it, or one that could be linked. */
export const RequirementAccount = Schema.Struct({ account: Account, linked: Schema.Boolean });
export type RequirementAccount = typeof RequirementAccount.Type;
/**
 * One requirement of the app in one scope: its linked accounts, oldest first, then the app owner's
 * other accounts of its provider, which could be linked.
 */
export const AppAccountRequirement = Schema.Struct({
  requirement: Schema.NonEmptyString,
  scope: AccountScope,
  provider: ProviderId,
  cardinality: Schema.Literals(["one", "many"]),
  accounts: Schema.Array(RequirementAccount),
});
export type AppAccountRequirement = typeof AppAccountRequirement.Type;
const linkErrors = [
  AccountProvisioned,
  StorageError,
  AppNotFound,
  AccountNotFound,
  RequirementMismatch,
] as const;
const linkChangeErrors = [...linkErrors, AppAccountLinksBlocked] as const;

/**
 * A dashboard sign-in for the requirement its route names. `account` replaces that account's
 * credentials instead of adding one; the app page is the only place credentials are entered.
 */
export const AppAccountTarget = Schema.Struct({
  account: Schema.optional(AccountId),
});
const appConnectionErrors = [
  AccountProvisioned,
  InteractiveRetirementBusy,
  InteractiveRetirementFailed,
  InteractiveReconnectUnsupported,
  StorageError,
  CredentialsError,
  ProviderNotFound,
  AccountNotFound,
  AuthMethodInvalid,
  AccountManagementBlocked,
  AppAccountLinksBlocked,
  AccountConnectionNotFound,
  AccountConnectionClosed,
  AccountConnectionTargetChanged,
  AccountConnectionRefused,
  AppNotFound,
  AccountSelectionInvalid,
  RequirementMismatch,
] as const;

/**
 * The account routes of one scope under `/dashboard/api/apps/:app/accounts/<scope>`: list, read one
 * requirement, link, unlink, and connect a new account by entering its fields or starting OAuth.
 * `app` routes link for every call; `user` routes link for the local user.
 */
const scopeEndpoints = <const S extends AccountScope>(scope: S) => {
  const path = `/dashboard/api/apps/:app/accounts/${scope}` as const;
  const params = { app: AppId };
  const requirement = { app: AppId, requirement: Schema.NonEmptyString };
  const link = { ...requirement, account: AccountId };
  const forEveryone = scope === "app";
  return [
    HttpApiEndpoint.get(`${scope}List`, path, {
      params,
      success: Schema.Array(AppAccountLink),
      error: [StorageError, AppNotFound],
    }).annotate(
      OpenApi.Description,
      forEveryone
        ? "List the accounts linked to this app's own requirements, oldest first per requirement, with each account's checks by this app. Every call and the app's background work use them."
        : "List the accounts linked to this app's user requirements, oldest first per requirement, with each account's checks by this app. Each call uses the one of a plain requirement and every one of a many() requirement.",
    ),
    HttpApiEndpoint.get(`${scope}Get`, `${path}/:requirement`, {
      params: requirement,
      success: AppAccountRequirement,
      error: linkErrors,
    }).annotate(
      OpenApi.Description,
      "Read one requirement of this scope: its linked accounts, then the other accounts of its provider that could be linked, each marked linked or not.",
    ),
    HttpApiEndpoint.put(`${scope}Link`, `${path}/:requirement/:account`, {
      params: link,
      success: AppAccountLink,
      error: linkChangeErrors,
    }).annotate(
      OpenApi.Description,
      "Link an account to one requirement of this scope. Linking an account to a plain requirement replaces the account linked to it before, which stays saved; for many() it adds one. Linking again changes nothing.",
    ),
    HttpApiEndpoint.delete(`${scope}Unlink`, `${path}/:requirement/:account`, {
      params: link,
      success: Schema.Struct({ requirement: Schema.NonEmptyString, account: AccountId }),
      error: linkChangeErrors,
    }).annotate(
      OpenApi.Description,
      forEveryone
        ? "Stop this app using an account for one of its own requirements. Calls and background work that need the requirement fail until another account is linked, and the app's webhooks registered with the account are removed. The account stays saved."
        : "Stop using an account for one of this app's user requirements. The account stays saved.",
    ),
    HttpApiEndpoint.post(`${scope}Connect`, `${path}/:requirement/connections`, {
      params: requirement,
      payload: Schema.Struct({
        ...AppAccountTarget.fields,
        method: AuthMethodName,
        label: Schema.optional(Schema.NonEmptyString),
        fields: AccountFieldsInput,
      }),
      success: Account,
      error: [...appConnectionErrors, AccountFieldsInvalid],
    }).annotate(
      OpenApi.Description,
      "Save a new account for one requirement of this scope from the fields entered on the app page, and link it to the requirement.",
    ),
    HttpApiEndpoint.post(`${scope}ConnectOAuth`, `${path}/:requirement/connections/oauth`, {
      params: requirement,
      payload: Schema.Struct({
        ...AppAccountTarget.fields,
        method: AuthMethodName,
        label: Schema.optional(Schema.NonEmptyString),
        client: Schema.optional(OAuthClientSelection),
      }),
      success: ConnectionSignIn,
      error: [
        ...appConnectionErrors,
        OAuthClientUnavailable,
        OAuthClientNotFound,
        OAuthSetupFailed,
      ],
    }).annotate(
      OpenApi.Description,
      "Start an OAuth sign-in for one requirement of this scope; completing it links the new account to the requirement.",
    ),
  ] as const;
};
const [appList, appGet, appLink, appUnlink, appConnect, appConnectOAuth] = scopeEndpoints("app");
const [userList, userGet, userLink, userUnlink, userConnect, userConnectOAuth] =
  scopeEndpoints("user");

/** Local session authentication, with explicit failures carried through AtomHttpApi. */
export class DashboardAccess extends HttpApiMiddleware.Service<DashboardAccess>()(
  "DashboardAccess",
  {
    error: [DashboardUnauthorized, DashboardForbidden, AuthStorageError],
  },
) {}

/** Install details for a trusted local dashboard session; never part of inventory responses. */
export const McpInstallation = Schema.Struct({
  endpoint: HttpUrl,
});
export type McpInstallation = typeof McpInstallation.Type;

/** Saved credentials are not proof that an upstream service is reachable. */
export const AccountSignIn = Schema.Union([
  Schema.Struct({ state: Schema.Literal("saved"), reconnectAt: Schema.NullOr(Schema.Date) }),
  Schema.Struct({ state: Schema.Literals(["reconnect", "unavailable"]) }),
]);
export type AccountSignIn = typeof AccountSignIn.Type;
/** Display metadata only; saved credential fields are never part of this projection. */
export const DashboardAccount = Schema.Struct({
  ...Account.fields,
  providerName: Schema.String,
  providerUrl: Schema.NullOr(HttpUrl),
  signIn: AccountSignIn,
  /** Checks by the apps that select the account; absent from single-account reads. */
  health: Schema.optionalKey(AccountHealth),
});
export type DashboardAccount = typeof DashboardAccount.Type;
/** Credential management uses the retained provider even when no installed app selects it. */
export const DashboardAccountDetail = Schema.Struct({
  account: DashboardAccount,
  provider: Provider,
  apps: Schema.Array(App),
  /** The latest check by each app in `apps`; reading it never runs a check. */
  health: AccountHealth,
  /** Whether deleting the account also asks its service to revoke access. */
  revocation: AccountRevocation.fields.revocation,
  canManage: Schema.Boolean,
});
export type DashboardAccountDetail = typeof DashboardAccountDetail.Type;
/** Public provider endpoints supply a logo domain when no catalog metadata is available. */
export const providerDisplayUrl = (
  definition: ProviderDefinition | undefined,
): typeof HttpUrl.Type | null => {
  if (definition === undefined) return null;
  for (const method of Object.values(definition.auth)) {
    if (method.type === "oauth2")
      return HttpUrl.make(
        new URL(
          method.discover !== undefined
            ? method.discover
            : (method.authorizationUrl ?? method.tokenUrl),
        ).origin,
      );
  }
  return null;
};
/** A cheap inventory read, without evaluating app code or fetching live tool catalogs. */
export const DashboardOverview = Schema.Struct({
  apps: Schema.Array(App),
  /** The accounts linked to each app, oldest first. */
  links: Schema.Array(Schema.Struct({ app: AppId, account: AccountId })),
  accounts: Schema.Array(DashboardAccount),
});
export type DashboardOverview = typeof DashboardOverview.Type;
/** Retained versions without loading every source file into the browser's list view. */
export const VersionSummary = Schema.Struct({
  id: VersionId,
  owner: OwnerId,
  createdAt: Schema.Date,
  fileCount: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type VersionSummary = typeof VersionSummary.Type;
/** Current configuration plus retained versions in the same code lineage, newest first. */
export const DashboardApp = Schema.Struct({
  app: App,
  versions: Schema.Array(VersionSummary),
  canDelete: Schema.Boolean,
  uiUrl: Schema.NullOr(HttpUrl),
});
export type DashboardApp = typeof DashboardApp.Type;

/**
 * Complete account-dependent catalog, without schemas, and the routers that group it. A selected
 * tool's schemas are read with `tool`: with every tool's schemas, a catalog such as Stripe's,
 * whose tools each reach most of its definitions, is hundreds of millions of characters.
 */
export const DashboardTools = Schema.Struct({
  tools: Schema.Array(ToolSummary),
  routers: Schema.Array(ToolRouter),
});
export type DashboardTools = typeof DashboardTools.Type;

/** Query results include a connection-local revision; heartbeats carry no product data. */
export const LiveSnapshot = <S extends Schema.Top, E extends Schema.Top>(value: S, error: E) =>
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("snapshot"),
      revision: Schema.Int,
      value: Schema.toCodecJson(value),
    }),
    Schema.Struct({
      type: Schema.Literal("failure"),
      revision: Schema.Int,
      error: Schema.toCodecJson(error),
    }),
    Schema.Struct({ type: Schema.Literal("heartbeat") }),
  ]);

const liveErrors = Schema.Union([DashboardUnauthorized, AuthStorageError]);
const toolErrors = [
  StorageError,
  CredentialsError,
  AppNotFound,
  AppNotDeployed,
  VersionNotFound,
  AppEvaluationFailed,
  ToolListingTimedOut,
  AppProviderFailed,
  AccountNotFound,
  AccountRequired,
  AccountChoiceUnsupported,
  AccountSelectionInvalid,
  ToolDiscoveryTimedOut,
  OAuthReconnectRequired,
  OAuthRenewalFailed,
] as const;

/** Product operations share typed session protection; programmatic SDK routes remain separate. */
const dashboardApi = HttpApi.make("local-dashboard").add(
  HttpApiGroup.make("dashboard")
    .add(
      HttpApiEndpoint.get("mcpInstallation", "/dashboard/api/mcp-installation", {
        success: McpInstallation,
      }),
    )
    .add(
      HttpApiEndpoint.get("liveOverview", "/dashboard/api/live/overview", {
        success: HttpApiSchema.StreamSse({
          data: LiveSnapshot(DashboardOverview, StorageError),
          error: liveErrors,
        }),
      }),
    )
    .add(
      HttpApiEndpoint.get("liveApp", "/dashboard/api/live/apps/:app", {
        params: { app: AppId },
        success: HttpApiSchema.StreamSse({
          data: LiveSnapshot(DashboardApp, Schema.Union([StorageError, AppNotFound])),
          error: liveErrors,
        }),
      }),
    )
    .add(
      HttpApiEndpoint.get("liveAccount", "/dashboard/api/live/accounts/:account", {
        params: { account: AccountId },
        success: HttpApiSchema.StreamSse({
          data: LiveSnapshot(DashboardAccountDetail, Schema.Union([StorageError, AccountNotFound])),
          error: liveErrors,
        }),
      }),
    )
    .add(
      HttpApiEndpoint.get("liveTools", "/dashboard/api/live/apps/:app/tools", {
        params: { app: AppId },
        success: HttpApiSchema.StreamSse({
          data: LiveSnapshot(DashboardTools, Schema.Union(toolErrors)),
          error: liveErrors,
        }),
      }),
    )
    .add(
      HttpApiEndpoint.get("overview", "/dashboard/api/overview", {
        success: DashboardOverview,
        error: StorageError,
      }),
    )
    .add(
      // Set once at startup, by data step 7, only while other owners' records have not moved.
      HttpApiEndpoint.get("ownerMigration", "/dashboard/api/owner-migration", {
        success: Schema.NullOr(LocalOwnerMigration),
      }),
    )
    .add(
      HttpApiEndpoint.get("app", "/dashboard/api/apps/:app", {
        params: { app: AppId },
        success: DashboardApp,
        error: [StorageError, AppNotFound],
      }),
    )
    .add(appList)
    .add(appGet)
    .add(appLink)
    .add(appUnlink)
    .add(appConnect)
    .add(appConnectOAuth)
    .add(userList)
    .add(userGet)
    .add(userLink)
    .add(userUnlink)
    .add(userConnect)
    .add(userConnectOAuth)
    .add(
      HttpApiEndpoint.delete("deleteApp", "/dashboard/api/apps/:app", {
        params: { app: AppId },
        success: Schema.Struct({ app: AppId }),
        error: [
          InteractiveRetirementBusy,
          InteractiveRetirementFailed,
          InteractiveReconnectUnsupported,
          StorageError,
          AppWebhooksActive,
          AppWorkflowsActive,
          AppDeletionBlocked,
        ],
      }),
    )
    .add(
      HttpApiEndpoint.get("source", "/dashboard/api/apps/:app/versions/:version", {
        params: { app: AppId, version: VersionId },
        success: Version,
        error: [StorageError, AppNotFound, AppNotDeployed, VersionNotFound],
      }),
    )
    .add(
      HttpApiEndpoint.get("sourceDisplay", "/dashboard/api/apps/:app/versions/:version/display", {
        params: { app: AppId, version: VersionId },
        success: VersionDisplay,
        error: [StorageError, AppNotFound, AppNotDeployed, VersionNotFound],
      }),
    )
    .add(
      HttpApiEndpoint.get(
        "sourceDisplayFile",
        "/dashboard/api/apps/:app/versions/:version/display/file",
        {
          params: { app: AppId, version: VersionId },
          query: SourceDisplayFileQuery,
          success: SourceDisplayFile,
          error: [StorageError, AppNotFound, AppNotDeployed, VersionNotFound, ...sourceErrors],
        },
      ),
    )
    .add(
      HttpApiEndpoint.get("tools", "/dashboard/api/apps/:app/tools", {
        params: { app: AppId },
        query: {
          cursor: Schema.optional(Cursor),
          limit: Schema.optional(PageLimit),
          version: Schema.optional(VersionId),
        },
        success: ToolPage,
        error: toolErrors,
      }),
    )
    .add(
      HttpApiEndpoint.get("tool", "/dashboard/api/apps/:app/tools/:tool", {
        params: { app: AppId, tool: ToolName },
        query: { version: Schema.optional(VersionId) },
        success: Tool,
        error: [...toolErrors, ToolNotFound],
      }),
    )
    .add(
      HttpApiEndpoint.post("runTool", "/dashboard/api/apps/:app/tools/run", {
        params: { app: AppId },
        payload: Schema.Struct({
          tool: ToolName,
          /** "query" for tools the catalog marks readOnly, otherwise "mutation". Omitted, it is read from the catalog. */
          kind: Schema.optional(ToolKind),
          input: Json,
          version: Schema.optional(VersionId),
        }),
        success: BrowserToolRun,
        error: [
          StorageError,
          CredentialsError,
          AppNotFound,
          AppNotDeployed,
          VersionNotFound,
          AppEvaluationFailed,
          AppProviderFailed,
          AccountNotFound,
          AccountRequired,
          AccountChoiceUnsupported,
          AccountSelectionInvalid,
          OAuthReconnectRequired,
          OAuthRenewalFailed,
          ToolNotFound,
          ToolKindMismatch,
          InputInvalid,
          ToolCallFailed,
          ToolElicitationFailed,
          ToolBlocked,
          ToolApprovalRequired,
          ToolPolicyFailed,
          RequestInvalid,
          DashboardForbidden,
          DashboardUnauthorized,
        ],
      }),
    )
    .add(
      HttpApiEndpoint.get("toolApproval", "/dashboard/api/apps/:app/tools/approvals/:requestId", {
        params: { app: AppId, requestId: ApprovalRequestId },
        success: BrowserApprovalView,
        error: [
          StorageError,
          AppNotFound,
          RequestInvalid,
          DashboardForbidden,
          DashboardUnauthorized,
          ToolRunApprovalRefused,
        ],
      }),
    )
    .add(
      HttpApiEndpoint.post(
        "answerToolApproval",
        "/dashboard/api/apps/:app/tools/approvals/:requestId",
        {
          params: { app: AppId, requestId: ApprovalRequestId },
          payload: BrowserApprovalAnswer,
          success: BrowserToolRunAnswer,
          error: [
            StorageError,
            CredentialsError,
            AppNotFound,
            RequestInvalid,
            DashboardForbidden,
            DashboardUnauthorized,
            ToolRunApprovalRefused,
          ],
        },
      ),
    )
    .add(
      HttpApiEndpoint.get("catalog", "/dashboard/api/catalog", {
        success: Schema.Array(CatalogEntry),
        error: CatalogUnavailable,
      }),
    )
    .add(
      HttpApiEndpoint.post("importApp", "/dashboard/api/catalog/import", {
        payload: Schema.Struct({ ...CatalogImport.fields, name: Schema.NonEmptyString }),
        success: DeployedApp,
        error: [
          CatalogUnavailable,
          CatalogImportFailed,
          StorageError,
          ...sourceErrors,
          VersionBuildFailed,
          BuildMemoryExceeded,
          SkillDefinitionInvalid,
          AppNameTaken,
          AppSlugTaken,
          AppNotFound,
          AppVersionChanged,
          AccountNotFound,
          AccountSelectionInvalid,
        ],
      }),
    )
    .add(
      HttpApiEndpoint.post("importCustomApp", "/dashboard/api/apps/import", {
        payload: Schema.Struct({ source: CustomAppInput }),
        success: DeployedApp,
        error: [
          CatalogImportFailed,
          StorageError,
          ...sourceErrors,
          VersionBuildFailed,
          BuildMemoryExceeded,
          SkillDefinitionInvalid,
          AppNameTaken,
          AppSlugTaken,
          AppNotFound,
          AppVersionChanged,
          AccountNotFound,
          AccountSelectionInvalid,
        ],
      }),
    )
    .add(
      HttpApiEndpoint.get("account", "/dashboard/api/accounts/:account", {
        params: { account: AccountId },
        success: DashboardAccountDetail,
        error: [StorageError, AccountNotFound],
      }),
    )
    .add(
      HttpApiEndpoint.post("checkCredentials", "/dashboard/api/apps/:app/credential-checks", {
        params: { app: AppId },
        payload: Schema.Struct({
          provider: ProviderId,
          method: AuthMethodName,
          fields: AccountFieldsInput,
        }),
        success: Schema.NullOr(CredentialCheck),
        error: [StorageError, AppNotFound, AuthMethodInvalid, AccountFieldsInvalid],
      }),
    )
    .add(
      HttpApiEndpoint.post("checkAccount", "/dashboard/api/accounts/:account/health", {
        params: { account: AccountId },
        success: AccountHealth,
        error: [StorageError, AccountNotFound],
      }),
    )
    .add(
      HttpApiEndpoint.patch("updateAccount", "/dashboard/api/accounts/:account", {
        params: { account: AccountId },
        /** Only supplied fields change; a null description removes it. */
        payload: Schema.Struct({
          label: Schema.optional(Schema.NonEmptyString),
          description: Schema.optional(
            Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
          ),
        }),
        success: Account,
        error: [StorageError, AccountNotFound, AccountManagementBlocked],
      }),
    )
    .add(
      HttpApiEndpoint.delete("disconnectAccount", "/dashboard/api/accounts/:account", {
        params: { account: AccountId },
        success: Schema.Struct({ account: AccountId }),
        error: [
          InteractiveRetirementBusy,
          InteractiveRetirementFailed,
          InteractiveReconnectUnsupported,
          StorageError,
          AccountLinkedToApp,
          AccountWebhooksActive,
          AccountWorkflowsActive,
          AccountManagementBlocked,
        ],
      }),
    )
    .add(
      HttpApiEndpoint.post("oauthSetup", "/dashboard/api/accounts/oauth/setup", {
        payload: Schema.Struct({ provider: ProviderId, method: AuthMethodName }),
        success: OAuthConnectOptions,
        error: [
          StorageError,
          CredentialsError,
          ProviderNotFound,
          AuthMethodInvalid,
          OAuthSetupFailed,
        ],
      }),
    )
    .add(
      // The callback's state finds its sign-in, so any tab of this dashboard can finish it.
      HttpApiEndpoint.post("completeOAuth", "/dashboard/api/accounts/oauth/complete", {
        payload: Schema.Struct({ callbackUrl: Schema.RedactedFromValue(HttpUrl) }),
        success: Account,
        error: [
          InteractiveRetirementBusy,
          InteractiveRetirementFailed,
          InteractiveReconnectUnsupported,
          StorageError,
          CredentialsError,
          ProviderNotFound,
          AccountNotFound,
          OAuthCompletionFailed,
          AccountConnectionNotFound,
          AccountConnectionClosed,
          AccountProvisioned,
          AccountConnectionTargetChanged,
          AccountConnectionRefused,
        ],
      }),
    )
    .add(
      HttpApiEndpoint.patch("renameApp", "/dashboard/api/apps/:app/name", {
        params: { app: AppId },
        payload: Schema.Struct({ name: AppName }),
        success: App,
        error: [StorageError, AppNotFound, AppNameTaken, AppSlugTaken, AppRenameBlocked],
      }),
    )
    .middleware(DashboardAccess),
  DashboardSchedules.middleware(DashboardAccess),
  DashboardAppBrowser.middleware(DashboardAccess),
  DashboardWorkflows.middleware(DashboardAccess),
  DashboardWebhooks.middleware(DashboardAccess),
  DashboardMcpConnections.middleware(DashboardAccess),
);
/** Every endpoint answers a request its schema rejects with `RequestInvalid`. */
export const DashboardApi = dashboardApi.middleware(RequestRejection);
