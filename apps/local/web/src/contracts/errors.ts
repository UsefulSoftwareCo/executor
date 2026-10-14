import { registryErrorMessage } from "@executor-js/ui/contracts/registry-error";
import type { LocalAppManagementApi } from "@executor-js/local-server/app-management";
import type { LocalWebhookSetupApi } from "@executor-js/local-server/webhook-setup";
import type { DashboardApi } from "@executor-js/local-server/contracts";
import type { AccountConnectApi } from "@executor-js/local-server/account-connections";
import { mayHaveWrittenFailure, type AccountId } from "@executor-js/sdk";
import { Cause, Match, Option, type Schema } from "effect";
import type { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import type { HttpClientError } from "effect/http";
import { pageOutdated } from "@executor-js/dashboard-start/build-change";
import type { Sse } from "effect/encoding";
import type { LiveConnectionLost } from "./api.ts";
import type { ToolCatalogChanged } from "@executor-js/local-server/contracts";

type Groups =
  | (typeof LocalAppManagementApi.groups)[keyof typeof LocalAppManagementApi.groups]
  | (typeof LocalWebhookSetupApi.groups)[keyof typeof LocalWebhookSetupApi.groups]
  | (typeof DashboardApi.groups)[keyof typeof DashboardApi.groups]
  | (typeof AccountConnectApi.groups)[keyof typeof AccountConnectApi.groups];
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
/** A page from a previous build fails against the upgraded server; reloading is the fix. */
const outdated = () => message("Executor was updated", "Reload this page to use the new version.");
const unavailable = () =>
  pageOutdated()
    ? outdated()
    : message("Could not reach Executor", "Check that the local server is running, then retry.");
const errorMessage = Match.type<DashboardError>().pipe(
  Match.tagsExhaustive({
    SkillRevisionChanged: () => ({
      title: "Skills changed",
      description: "Reload the skill to read its current instructions and references.",
    }),
    AppSkillNotFound: () =>
      message("Skill file unavailable", "Reload this app’s skills and choose the file again."),
    WorkflowFailure: () =>
      message(
        "Workflow could not complete",
        "Check this run or its linked accounts before trying again.",
      ),
    ConnectionNotFound: () =>
      message("Connection unavailable", "This connection was revoked or no longer exists."),
    ConnectionIdTaken: () =>
      message("Connection not created", "Close the form and create the connection again."),
    ConnectionAccessInvalid: ({ reason }) =>
      message(
        "Connection not saved",
        {
          app: "An included app is no longer available. Remove it and try again.",
          account: "A selected account is no longer available for this app. Choose another one.",
          target: "Choose how each included app runs.",
        }[reason],
      ),
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
    AccountConnectionRefused: () =>
      message(
        "Account not connected",
        "Connecting this account for the app was refused, so nothing was saved. Start account setup again.",
      ),
    OAuthSetupFailed: (error) =>
      message(error.title, `${error.description} ${error.recovery.action}`),
    OAuthCompletionFailed: (error) =>
      message(error.title, `${error.description} ${error.recovery.action}`),
    // Local has one subject, who manages every app, so an app's own account is theirs to reconnect.
    OAuthReconnectRequired: (error) => ({
      title:
        error.appRequirement === undefined
          ? "This account needs a new sign-in"
          : `The app’s “${error.appRequirement}” account needs a new sign-in`,
      description:
        error.appRequirement === undefined
          ? "Reconnect to load its tools."
          : "The app uses this account for every call. Reconnect it to load its tools.",
      account: error.account,
    }),
    OAuthRenewalFailed: (error) =>
      message(error.title, `${error.description} ${error.recovery.action}`),
    DashboardUnauthorized: () =>
      message(
        "Session ended",
        "Restart Executor desktop, or run the CLI’s pair command and open its link.",
      ),
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
    SourcePathConflict: ({ file, nested }) =>
      message(
        "File and folder share a path",
        `${file} is a file, so ${nested} cannot be inside it. Rename or remove one, then save again.`,
      ),
    SourcePathNotUnicode: ({ path }) =>
      message(
        "File path is not valid Unicode",
        `The file path ${JSON.stringify(path)} is not valid Unicode. Rename the file, then save again.`,
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
    AppAccountLinksBlocked: () =>
      message(
        "Managed by Executor",
        "This app is part of the local server, which links its account itself.",
      ),
    DeploymentNotFound: () =>
      message("Deployment not found", "Choose another retained deployment."),
    AccountRequired: ({ scope }) =>
      scope === "app"
        ? message(
            "Link an account first",
            "This app needs its own account before its live tools can load. Link one under App accounts on the Accounts tab.",
          )
        : message(
            "Connect an account first",
            "This app needs an account before its live tools can load. Connect one from the Accounts tab.",
          ),
    AccountChoiceUnsupported: () =>
      message(
        "Accounts are not chosen per call",
        "Each app uses the accounts linked to it. Change them in the app's Accounts tab.",
      ),
    AccountNotFound: () =>
      message("Chosen account is unavailable", "Choose an available account for this app."),
    RequirementMismatch: ({ reason }) =>
      message(
        "Account not linked",
        reason === "provider"
          ? "This requirement uses another kind of account. Link an account of the kind it names."
          : "This app no longer has that account requirement here. Reload the app's accounts.",
      ),
    AccountLinkedToApp: () =>
      message(
        "This account is linked to an app for everyone",
        "An app uses it as its own account. Unlink it under App accounts on the app's Accounts tab, then delete it.",
      ),
    AccountSelectionInvalid: () =>
      message(
        "Account selection needs attention",
        "Review this app's account requirements and choose matching accounts.",
      ),
    AppProviderFailed: (error) =>
      message(error.title, `${error.description} ${error.recovery.action}`),
    AppEvaluationFailed: () =>
      message(
        "Tools could not load",
        "The app's live definition failed. Review its source and account selection, then retry.",
      ),
    ToolDiscoveryTimedOut: () =>
      message("The app took too long", "Its live tool catalog did not finish loading. Try again."),
    ToolListingTimedOut: () =>
      message(
        "The app took too long",
        "Its tool catalog is still loading in the background. Try again shortly.",
      ),
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
    ToolNotFound: () =>
      message("Tool unavailable", "This tool is no longer in the app’s catalog. Choose another."),
    ToolKindMismatch: () =>
      message(
        "Tool changed",
        "This tool changed between a query and a mutation. Reload the app’s tools and try again.",
      ),
    InputInvalid: () => message("Check the input", "The input does not match this tool’s schema."),
    ToolCallFailed: () =>
      message("The tool failed", "It may have already made changes. Check before trying again."),
    ToolBlocked: (error) => message(error.title, `${error.description} ${error.recovery.action}`),
    ToolApprovalRequired: () =>
      message(
        "Approval required",
        "This call needs approval, which this request cannot give, so Executor will not run it from here. Run it again from the Tools tab to review it.",
      ),
    ToolRunApprovalRefused: (error) =>
      message(error.title, `${error.description} ${error.recovery.action}`),
    ToolPolicyFailed: () =>
      message("Approval policy failed", "The tool’s approval policy could not be evaluated."),
    ToolElicitationFailed: ({ reason }) =>
      message(
        "The tool needed more input",
        `${Match.value(reason).pipe(
          Match.when("transaction", () => "It requested input inside a database transaction."),
          Match.when(
            "unavailable",
            () => "Run it from an MCP client that supports input requests.",
          ),
          Match.when("invalid-request", () => "It requested an invalid input form."),
          Match.when("invalid-response", () => "The response did not match the requested form."),
          Match.when("transport", () => "The input request could not be completed."),
          Match.when("expired", () => "The input request expired."),
          Match.when("forbidden", () => "Access changed while the tool was waiting."),
          Match.exhaustive,
        )} Earlier tool actions may have completed.`,
      ),
    StorageError: () => message("Data could not load", "Check the local server, then retry."),
    CredentialsError: () =>
      message(
        "The selected account could not load",
        "Check the local server's credential configuration.",
      ),
    CatalogUnavailable: () =>
      message("Catalog unavailable", "The app catalog could not be reached. Try again."),
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
    BuildMemoryExceeded: (error) =>
      message(error.title, `${error.description} ${error.recovery.action}`),
    CatalogImportFailed: (error) => message("App could not be imported", error.reason),
    HttpClientError: unavailable,
    SchemaError: () =>
      pageOutdated()
        ? outdated()
        : message(
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
    OAuthClientNotFound: () =>
      message("OAuth client unavailable", "Choose another OAuth client, or enter its details."),
    AuthForbidden: () =>
      message("Request not allowed", "Open the dashboard from this local server’s address."),
    AuthStorageError: () =>
      message("Session could not load", "Check the local server, then retry."),
    PairingUnauthorized: () =>
      message(
        "Sign-in required",
        "Open Executor desktop, or run the CLI’s pair command to sign in.",
      ),
  }),
);
const newConnectionLink = () => "Ask your agent for a new connection link.";
/**
 * A connection link page cannot start account setup itself, so a request it can no longer finish
 * needs a new link from the agent instead of the error's dashboard recovery.
 */
export const connectionLinkRecovery = Match.type<DashboardError>().pipe(
  Match.tags({
    AccountConnectionNotFound: newConnectionLink,
    AccountConnectionClosed: newConnectionLink,
    AccountConnectionTargetChanged: newConnectionLink,
    AccountConnectionRefused: newConnectionLink,
  }),
  Match.orElse(() => undefined),
);
/**
 * Unexpected defects receive safe copy without printing arbitrary cause values. A failed call that
 * may have written shows the presentation every surface shows for it, with the write warning as its
 * action, instead of the fixed copy above, which may advise another call.
 */
export const failureMessage = (cause: Cause.Cause<DashboardError>): FailureMessage =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: (error) => {
      const written = mayHaveWrittenFailure(error);
      return written === undefined
        ? errorMessage(error)
        : message(written.title, `${written.description} ${written.recovery.action}`);
    },
    onNone: () => message("Something went wrong", "The request did not finish. Try again."),
  });
