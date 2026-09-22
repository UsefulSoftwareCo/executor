import { registryErrorMessage } from "@executor-js/ui/contracts/registry-error";
import type { LocalAppManagementApi } from "@executor-js/local-server/app-management";
import type { LocalWebhookSetupApi } from "@executor-js/local-server/webhook-setup";
import type { DashboardApi } from "@executor-js/local-server/contracts";
import type { AccountConnectApi } from "@executor-js/local-server/account-connections";
import type { AppAuthenticationApi } from "@executor-js/local-server/app-ui";
import type { AccountId } from "@executor-js/sdk";
import { Cause, Match, Option, type Schema } from "effect";
import type { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import type { HttpClientError } from "effect/unstable/http";
import type { Sse } from "effect/unstable/encoding";
import type { LiveConnectionLost } from "./api.ts";
import type { ToolCatalogChanged } from "@executor-js/local-server/contracts";

type Groups =
  | (typeof LocalAppManagementApi.groups)[keyof typeof LocalAppManagementApi.groups]
  | (typeof LocalWebhookSetupApi.groups)[keyof typeof LocalWebhookSetupApi.groups]
  | (typeof DashboardApi.groups)[keyof typeof DashboardApi.groups]
  | (typeof AccountConnectApi.groups)[keyof typeof AccountConnectApi.groups]
  | (typeof AppAuthenticationApi.groups)[keyof typeof AppAuthenticationApi.groups];
/** Derived from the public HTTP contracts; adding a failure requires a presentation below. */
export type DashboardError =
  | HttpApiEndpoint.Errors<HttpApiGroup.Endpoints<Groups>>
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | LiveConnectionLost
  | Cause.NoSuchElementError
  | ToolCatalogChanged
  | Sse.Retry
  | Sse.SseError;
/** Safe display fields only. A reconnect action keeps its branded account identity. */
export interface FailureMessage {
  readonly title: string;
  readonly description: string;
  readonly account?: AccountId;
}
const message = (title: string, description: string): FailureMessage => ({ title, description });
const unavailable = () =>
  message("Could not reach Executor", "Check that the local server is running, then retry.");
const errorMessage = Match.type<DashboardError>().pipe(
  Match.tagsExhaustive({
    AppSkillNotFound: () =>
      message("Skill file unavailable", "Reload this app’s skills and choose the file again."),
    WorkflowFailure: () =>
      message("Workflows unavailable", "The workflow data could not be loaded. Try again."),
    ScheduleNotFound: () =>
      message("Schedule unavailable", "This schedule or run is no longer available."),
    ScheduleConflict: () =>
      message(
        "Schedule changed",
        "The schedule is busy or changed. Check its current status and try again.",
      ),
    ScheduleInvalid: () =>
      message("Invalid schedule", "Update the interval or calendar timing in the app source."),
    RegistryError: (error) => message("Public app unavailable", registryErrorMessage(error)),
    AppAccessDenied: () =>
      message("Action unavailable", "You do not have permission to change this app."),
    ConnectionLinkRejected: () =>
      message("This connection link is invalid", "Ask your agent for a new connection link."),
    AccountConnectionNotFound: () =>
      message("Connection not found", "Ask your agent for a new connection link."),
    AccountConnectionTargetChanged: () =>
      message(
        "This app’s setup changed",
        "No credentials were saved. Ask your agent for a new connection link.",
      ),
    AccountConnectionClosed: () =>
      message("This connection has ended", "Ask your agent for a new connection link."),
    OAuthSetupFailed: (error) =>
      message(
        "Could not connect the account",
        error.reason === "invalid_client"
          ? "Check the OAuth client ID and secret, then try again."
          : error.reason === "token_exchange"
            ? "The service could not complete the connection. Try again."
            : "Check the provider's OAuth configuration, then try again.",
      ),
    OAuthCompletionFailed: (error) =>
      message(
        "Sign-in did not finish",
        error.reason === "invalid_client"
          ? "The OAuth client was rejected. Update its details and try again."
          : "Your saved credentials have not changed. Start a new sign-in to try again.",
      ),
    OAuthReconnectRequired: (error) => ({
      title: "This account needs a new sign-in",
      description: "Reconnect to load its tools.",
      account: error.account,
    }),
    DashboardUnauthorized: () =>
      message("Session ended", "Run executor pair and open its connection link."),
    DashboardForbidden: () =>
      message("Open this server directly", "Use the dashboard at http://127.0.0.1:4312."),
    AppNotDeployed: () =>
      message(
        "App not deployed",
        "Deploy this app before running its tools or configuring accounts.",
      ),
    SourceError: (error) =>
      error.reason === "conflict"
        ? message("Source changed", "Reload the latest source before saving again.")
        : message(
            "Source unavailable",
            "The app source could not be saved or loaded. Check its files and try again.",
          ),
    AppNotFound: () =>
      message(
        "App not found",
        "This app may have been removed. Return to Apps to see what is available.",
      ),
    AccountManagementBlocked: () =>
      message("Managed by Executor", "This account is maintained by the local server."),
    AppRenameBlocked: () =>
      message("Managed by Executor", "This app is part of the local server and cannot be renamed."),
    AppDeletionBlocked: () =>
      message("Managed by Executor", "This app is part of the local server and cannot be deleted."),
    DeploymentNotFound: () =>
      message("Deployment not found", "Choose another retained deployment."),
    AccountRequired: () =>
      message(
        "Select an account first",
        "This app needs an account before its live tools can load. Choose an account from the Accounts tab.",
      ),
    AccountNotFound: () =>
      message("Selected account is unavailable", "Choose an available account for this app."),
    AccountSelectionInvalid: () =>
      message(
        "Account selection needs attention",
        "Review this app's account requirements and update its selection.",
      ),
    AppEvaluationFailed: () =>
      message(
        "Tools could not load",
        "The app's live definition failed. Review its source and account selection, then retry.",
      ),
    ToolDiscoveryTimedOut: () =>
      message("The app took too long", "Its live tool catalog did not finish loading. Try again."),
    ToolCatalogChanged: () =>
      message("The tool catalog changed", "Try again to load the current tool catalog."),
    AppWorkflowsActive: () =>
      message(
        "Workflows are still running",
        "Wait for this app’s runs to finish or terminate them before deleting it.",
      ),
    AccountWorkflowsActive: () =>
      message(
        "Workflows still use this account",
        "Wait for its runs to finish or terminate them before deleting it.",
      ),
    AppWebhooksActive: () =>
      message(
        "Webhooks are still registered",
        "Remove this app’s webhook subscriptions before deleting it.",
      ),
    AccountWebhooksActive: () =>
      message(
        "Webhooks still use this account",
        "Remove its webhook subscriptions before deleting it.",
      ),
    WebhookNotFound: () => message("Webhook not found", "Ask your agent for a current setup link."),
    WebhookConflict: () => message("Webhook setup changed", "Reload this page before continuing."),
    WebhookFailed: () =>
      message(
        "Webhook setup could not finish",
        "Check the setup details and connected accounts, then try again.",
      ),
    RequestInvalid: () => message("Check the setup details", "Correct the fields and try again."),
    StorageError: () => message("Data could not load", "Check the local server, then retry."),
    CredentialsError: () =>
      message(
        "The selected account could not load",
        "Check the local server's credential configuration.",
      ),
    CatalogUnavailable: () =>
      message("Catalog unavailable", "integrations.sh could not be reached. Try again."),
    AppDeploymentChanged: () =>
      message("App changed", "Reload its source before updating or activating a deployment."),
    AppSlugTaken: () =>
      message(
        "App address already in use",
        "Another app name produces this address. Choose a different name.",
      ),
    AppNameTaken: () =>
      message("Name already in use", "Choose another app name to keep the existing app."),
    AccountFieldsInvalid: () =>
      message("Check the account fields", "The supplied fields do not match this sign-in method."),
    SkillDefinitionInvalid: ({ file }) =>
      message("Skill could not load", `Fix the skill definition in ${file} and deploy again.`),
    DeploymentBuildFailed: (error) =>
      message(
        "App could not build",
        error.reason === "App build failed"
          ? "Check its source and dependencies, then try again. The running version is unchanged."
          : error.reason,
      ),
    CatalogImportFailed: (error) => message("App could not be imported", error.reason),
    HttpClientError: unavailable,
    SchemaError: () =>
      message(
        "Unexpected server response",
        "Check that the dashboard and server use the same version, then retry.",
      ),
    LiveConnectionLost: unavailable,
    NoSuchElementError: unavailable,
    Retry: unavailable,
    SseError: () => message("Live updates could not load", "Reload the page to reconnect."),
    ProviderNotFound: () =>
      message(
        "Provider unavailable",
        "This sign-in provider is no longer available. Open the app’s account setup.",
      ),
    AuthMethodInvalid: () =>
      message("Sign-in method unavailable", "Choose another sign-in method for this account."),
    OAuthClientUnavailable: () =>
      message("OAuth client required", "Enter your OAuth client details to connect this account."),
    AuthForbidden: () =>
      message("Request not allowed", "Open the dashboard from this local server’s address."),
    AuthStorageError: () =>
      message("Session could not load", "Check the local server, then retry."),
    PairingUnauthorized: () =>
      message("Connection link expired", "Run executor pair and open a new connection link."),
    UiUnauthorized: () => message("Session ended", "Reopen the app URL to sign in again."),
    UiForbidden: () => message("App access denied", "This sign-in request cannot access the app."),
    UiFailed: () =>
      message(
        "App could not open",
        "Check the app’s deployment and account selection, then retry.",
      ),
  }),
);
/** Unexpected defects receive safe copy without printing arbitrary cause values. */
export const failureMessage = (cause: Cause.Cause<DashboardError>): FailureMessage =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: errorMessage,
    onNone: () => message("Something went wrong", "The request did not finish. Try again."),
  });
