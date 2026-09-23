import { SourceDisplayQuery } from "@executor-js/app-management/contracts/source-display";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { Profile } from "@executor-js/sdk/core";
import { DashboardAppBrowser } from "./app-browser.ts";
import { DashboardWorkflows, DashboardWebhooks } from "./resources.ts";
import { DashboardProfiles } from "./profiles.ts";
import { ProfileId, ProfileRevision } from "@executor-js/sdk/core";
import { ProfileErrors } from "@executor-js/sdk/core";
import { AppWorkflowsActive, AccountWorkflowsActive } from "@executor-js/sdk/core";
import { DashboardSchedules } from "./schedules.ts";
import { AccountWebhooksActive } from "@executor-js/sdk/core";
import { AppWebhooksActive } from "@executor-js/sdk/core";
/** Browser-safe read contracts for inspecting the local Executor instance. */
import {
  AccountConnectionTargetChanged,
  AccountConnectionId,
  AccountConnectionNotFound,
  AccountConnectionClosed,
  Account,
  AccountNotFound,
  AccountRequired,
  AccountSelectionInvalid,
  App,
  DeployedApp,
  AppNotDeployed,
  AppEvaluationFailed,
  AppProviderFailed,
  AppId,
  AppName,
  AppNotFound,
  AppDeploymentChanged,
  CredentialsError,
  Cursor,
  Deployment,
  DeploymentId,
  DeploymentNotFound,
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
  DeploymentBuildFailed,
  BuildMemoryExceeded,
  SkillDefinitionInvalid,
  OAuthClientInput,
  OAuthClientSetup,
  OAuthClientUnavailable,
  OAuthCompletionFailed,
  OAuthSetupFailed,
  OAuthReconnectRequired,
  HttpUrl,
  Provider,
  AccountId,
  Tool,
  type ProviderDefinition,
} from "@executor-js/sdk";
import {
  CatalogEntry,
  CatalogImportFailed,
  CatalogUnavailable,
  CatalogImport,
  CustomAppInput,
} from "@executor-js/catalog/contracts";
import { ConnectionSignIn } from "./account-connections.ts";
import { AuthStorageError } from "./auth.ts";
import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
} from "effect/unstable/httpapi";

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
/** The server's own API connection is managed at the host boundary. */
export class AccountManagementBlocked extends Schema.TaggedError<AccountManagementBlocked>()(
  "AccountManagementBlocked",
  { account: AccountId },
  {
    httpApiStatus: 409,
    description: "This account is managed by the local server and cannot be changed here.",
  },
) {}
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
});
export type DashboardAccount = typeof DashboardAccount.Type;
/** Credential management uses the retained provider even when no installed app selects it. */
export const DashboardAccountDetail = Schema.Struct({
  account: DashboardAccount,
  provider: Provider,
  apps: Schema.Array(App),
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
  profiles: Schema.Array(Profile),
  apps: Schema.Array(App),
  accounts: Schema.Array(DashboardAccount),
});
export type DashboardOverview = typeof DashboardOverview.Type;
/** Retained versions without loading every source file into the browser's list view. */
export const DeploymentSummary = Schema.Struct({
  id: DeploymentId,
  owner: OwnerId,
  createdAt: Schema.Date,
  fileCount: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type DeploymentSummary = typeof DeploymentSummary.Type;
/** Current configuration plus retained deployments in the same code lineage, newest first. */
export const DashboardApp = Schema.Struct({
  app: App,
  deployments: Schema.Array(DeploymentSummary),
  canDelete: Schema.Boolean,
  uiUrl: Schema.NullOr(HttpUrl),
});
export type DashboardApp = typeof DashboardApp.Type;

/** Complete account-dependent catalog. Tool schemas remain dynamic, never retained deployment metadata. */
export const DashboardTools = Schema.Struct({ tools: Schema.Array(Tool) });
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

/** An upstream catalog changed across pages instead of producing a complete inventory. */
export class ToolCatalogChanged extends Schema.TaggedError<ToolCatalogChanged>()(
  "ToolCatalogChanged",
  { app: AppId },
  {
    httpApiStatus: 409,
    description: "The app's tools changed while loading. Try again.",
  },
) {}

const liveErrors = Schema.Union([DashboardUnauthorized, AuthStorageError]);
const toolErrors = [
  ...ProfileErrors,
  StorageError,
  CredentialsError,
  AppNotFound,
  AppNotDeployed,
  DeploymentNotFound,
  AppEvaluationFailed,
  AppProviderFailed,
  AccountNotFound,
  AccountRequired,
  AccountSelectionInvalid,
  ToolDiscoveryTimedOut,
  OAuthReconnectRequired,
] as const;

/** Product operations share typed session protection; programmatic SDK routes remain separate. */
export const DashboardApi = HttpApi.make("local-dashboard").add(
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
        query: {
          profile: Schema.optional(ProfileId),
          expectedProfileRevision: Schema.optional(ProfileRevision),
        },
        success: HttpApiSchema.StreamSse({
          data: LiveSnapshot(DashboardTools, Schema.Union([...toolErrors, ToolCatalogChanged])),
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
      HttpApiEndpoint.get("app", "/dashboard/api/apps/:app", {
        params: { app: AppId },
        success: DashboardApp,
        error: [StorageError, AppNotFound],
      }),
    )
    .add(
      HttpApiEndpoint.delete("deleteApp", "/dashboard/api/apps/:app", {
        params: { app: AppId },
        success: Schema.Struct({ app: AppId }),
        error: [StorageError, AppWebhooksActive, AppWorkflowsActive, AppDeletionBlocked],
      }),
    )
    .add(
      HttpApiEndpoint.get("source", "/dashboard/api/apps/:app/deployments/:deployment", {
        params: { app: AppId, deployment: DeploymentId },
        query: SourceDisplayQuery,
        success: Deployment,
        error: [StorageError, AppNotFound, AppNotDeployed, DeploymentNotFound],
      }),
    )
    .add(
      HttpApiEndpoint.get("tools", "/dashboard/api/apps/:app/tools", {
        params: { app: AppId },
        query: {
          profile: Schema.optional(ProfileId),
          expectedProfileRevision: Schema.optional(ProfileRevision),
          cursor: Schema.optional(Cursor),
          limit: Schema.optional(PageLimit),
          deployment: Schema.optional(DeploymentId),
        },
        success: ToolPage,
        error: [
          ...ProfileErrors,
          StorageError,
          CredentialsError,
          AppNotFound,
          AppNotDeployed,
          DeploymentNotFound,
          AppEvaluationFailed,
          AppProviderFailed,
          AccountNotFound,
          AccountRequired,
          AccountSelectionInvalid,
          ToolDiscoveryTimedOut,
          OAuthReconnectRequired,
        ],
      }),
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
          DeploymentBuildFailed,
          BuildMemoryExceeded,
          SkillDefinitionInvalid,
          AppNameTaken,
          AppSlugTaken,
          AppNotFound,
          AppDeploymentChanged,
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
          DeploymentBuildFailed,
          BuildMemoryExceeded,
          SkillDefinitionInvalid,
          AppNameTaken,
          AppSlugTaken,
          AppNotFound,
          AppDeploymentChanged,
          AccountNotFound,
          AccountSelectionInvalid,
        ],
      }),
    )
    .add(
      HttpApiEndpoint.post("addAccount", "/dashboard/api/accounts", {
        payload: Schema.Struct({
          provider: ProviderId,
          method: AuthMethodName,
          label: Schema.NonEmptyString,
          fields: AccountFieldsInput,
        }),
        success: Account,
        error: [
          StorageError,
          CredentialsError,
          ProviderNotFound,
          AuthMethodInvalid,
          AccountFieldsInvalid,
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
      HttpApiEndpoint.patch("renameAccount", "/dashboard/api/accounts/:account", {
        params: { account: AccountId },
        payload: Schema.Struct({ label: Schema.NonEmptyString }),
        success: Account,
        error: [StorageError, AccountNotFound, AccountManagementBlocked],
      }),
    )
    .add(
      HttpApiEndpoint.put(
        "replaceAccountCredentials",
        "/dashboard/api/accounts/:account/credentials",
        {
          params: { account: AccountId },
          payload: Schema.Struct({ fields: AccountFieldsInput }),
          success: Account,
          error: [
            StorageError,
            CredentialsError,
            AccountNotFound,
            ProviderNotFound,
            AuthMethodInvalid,
            AccountFieldsInvalid,
            AccountManagementBlocked,
          ],
        },
      ),
    )
    .add(
      HttpApiEndpoint.post("reconnectAccount", "/dashboard/api/accounts/:account/oauth/start", {
        params: { account: AccountId },
        payload: Schema.Struct({ client: Schema.optional(OAuthClientInput) }),
        success: ConnectionSignIn,
        error: [
          StorageError,
          CredentialsError,
          AccountNotFound,
          ProviderNotFound,
          AuthMethodInvalid,
          OAuthClientUnavailable,
          OAuthSetupFailed,
          AccountManagementBlocked,
          ...ProfileErrors,
          AccountConnectionNotFound,
          AccountConnectionClosed,
          AccountConnectionTargetChanged,
          AppNotFound,
          AccountSelectionInvalid,
        ],
      }),
    )
    .add(
      HttpApiEndpoint.delete("disconnectAccount", "/dashboard/api/accounts/:account", {
        params: { account: AccountId },
        success: Schema.Struct({ account: AccountId }),
        error: [
          StorageError,
          AccountWebhooksActive,
          AccountWorkflowsActive,
          AccountManagementBlocked,
        ],
      }),
    )
    .add(
      HttpApiEndpoint.post("oauthSetup", "/dashboard/api/accounts/oauth/setup", {
        payload: Schema.Struct({ provider: ProviderId, method: AuthMethodName }),
        success: OAuthClientSetup,
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
      HttpApiEndpoint.post("startOAuth", "/dashboard/api/accounts/oauth/start", {
        payload: Schema.Struct({
          provider: ProviderId,
          method: AuthMethodName,
          label: Schema.NonEmptyString,
          client: Schema.optional(OAuthClientInput),
        }),
        success: ConnectionSignIn,
        error: [
          StorageError,
          CredentialsError,
          ProviderNotFound,
          AuthMethodInvalid,
          OAuthClientUnavailable,
          OAuthSetupFailed,
          AccountNotFound,
          ...ProfileErrors,
          AccountConnectionNotFound,
          AccountConnectionClosed,
          AccountConnectionTargetChanged,
          AppNotFound,
          AccountSelectionInvalid,
        ],
      }),
    )
    .add(
      HttpApiEndpoint.post("completeOAuth", "/dashboard/api/accounts/oauth/complete", {
        payload: Schema.Struct({
          connection: AccountConnectionId,
          callbackUrl: Schema.RedactedFromValue(HttpUrl),
        }),
        success: Account,
        error: [
          StorageError,
          CredentialsError,
          ProviderNotFound,
          AccountNotFound,
          OAuthCompletionFailed,
          ...ProfileErrors,
          AccountConnectionNotFound,
          AccountConnectionClosed,
          AccountConnectionTargetChanged,
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
  DashboardProfiles.middleware(DashboardAccess),
  DashboardWorkflows.middleware(DashboardAccess),
  DashboardWebhooks.middleware(DashboardAccess),
);
