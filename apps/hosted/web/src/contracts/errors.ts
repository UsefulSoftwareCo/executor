import { registryErrorMessage } from "@executor-js/ui/contracts/registry-error";
import type { HostedApi } from "@executor-js/hosted-server/contracts";
import { Cause, Match, Option, type Schema } from "effect";
import type { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import type { HttpClientError } from "effect/unstable/http";

type Groups = (typeof HostedApi.groups)[keyof typeof HostedApi.groups];
/** The hosted API owns its error algebra, including membership and authentication failures. */
export type HostedError =
  | HttpApiEndpoint.Errors<HttpApiGroup.Endpoints<Groups>>
  | HttpClientError.HttpClientError
  | Schema.SchemaError;
const errorMessage = Match.type<HostedError>().pipe(
  Match.tagsExhaustive({
    ProfileNotFound: () => "This profile is no longer available for this app.",
    ProfileConflict: ({ reason }) =>
      ({
        revision: "Your account selection changed. Reload it before trying again.",
        idempotency:
          "This request already created a different profile. Close the form and try again.",
        inactive: "This profile is disabled or has been removed. Check the profile menu.",
        "active-resources":
          "Background work is still stopping. Check profile status before trying again.",
      })[reason],
    AccessConflict: ({ reason }) =>
      ({
        changed:
          "Access settings changed while you were editing. Use Reset changes to load the latest settings, then try again.",
        groups_changed:
          "One of the selected groups is no longer available. Choose the current groups.",
        creator_unavailable:
          "Only me is available for apps with a current creator. Choose groups or everyone instead.",
        personal_account:
          "Personal accounts stay private. Connect a shared account to give your team access.",
      })[reason],
    ScheduleNotFound: () => "This schedule or run is no longer available.",
    ScheduleConflict: () =>
      "The schedule is busy or changed. Check its current status and try again.",
    ScheduleInvalid: () => "Update the interval or calendar timing in the app source.",
    GroupNotFound: () =>
      "This group is unavailable or you do not have access. Ask an organization admin.",
    GroupsUnavailable: () => "Groups could not be loaded or saved. Try again.",
    GroupConflict: ({ reason }) =>
      ({
        changed:
          "This group changed while you were editing. Your changes were not saved. Close this form, refresh, and try again.",
        name_taken: "A group with this name already exists. Choose another name.",
        members_changed:
          "Organization membership changed. Your changes were not saved. Close this form and select the current members.",
      })[reason],
    RegistryError: registryErrorMessage,
    AppAccessDenied: () => "You do not have permission to change this app.",
    ExecutionLimitReached: () =>
      "Your organization has reached its execution limit. The tool did not run. Ask an organization admin to review the limit.",
    ExecutionAdmissionUnavailable: () =>
      "We could not check your execution allowance. The tool did not run. Try again.",
    AppSlugTaken: () => "Another app name produces this address. Choose a different name.",
    AppNameTaken: () => "An app already uses this name. Choose another name.",
    AppDeploymentChanged: () =>
      "This app changed while you were editing. Reload its source and try again.",
    AppDataNotFound: () => "This data operation is no longer available. Reload the app.",
    AppDataFailed: () => "The app could not complete this data operation.",
    AppNotDeployed: () => "Deploy this app before running its tools or configuring accounts.",
    SourceError: (error) =>
      error.reason === "conflict"
        ? "The source changed elsewhere. Reload it before saving again."
        : "The app source could not be saved or loaded. Check its files and try again.",
    AppNotFound: () => "This app is no longer available in this organization.",
    SkillRevisionChanged: () =>
      "Skills changed. Reload the skill to read its current instructions and references.",
    AppSkillNotFound: () => "This skill file is no longer available. Reload the app's skills.",
    DeploymentNotFound: () =>
      "This deployment is no longer available. Reload the app and try again.",
    SkillDefinitionInvalid: ({ file }) => `Fix the skill definition in ${file} and deploy again.`,
    DeploymentBuildFailed: () =>
      "The app could not be built. Check its source or try a different catalog entry.",
    BuildMemoryExceeded: (error) => `${error.description} ${error.recovery.action}`,
    CatalogImportFailed: () =>
      "The app could not be imported. Check its source or try a different catalog entry.",
    AccountRequired: () => "Connect an account to load this app’s tools.",
    AccountSelectionInvalid: () => "Select accounts that match this app’s requirements.",
    AccountFieldsInvalid: () => "Check the account details and try again.",
    AuthMethodInvalid: () =>
      "This sign-in method is no longer available. Start account setup again.",
    AccountConnectionNotFound: () =>
      "This connection is no longer available. Start account setup again.",
    AccountConnectionClosed: () => "This connection has ended. Start account setup again.",
    AccountConnectionTargetChanged: () =>
      "The app’s account setup changed. Close this form and try again.",
    ProviderNotFound: () => "This provider is no longer available. Reload the app and try again.",
    OAuthReconnectRequired: () => "This account needs to sign in again.",
    OAuthClientUnavailable: () =>
      "This provider needs an OAuth client. Enter its client details below.",
    OAuthSetupFailed: (error) => `${error.description} ${error.recovery.action}`,
    OAuthCompletionFailed: (error) =>
      error.reason === "invalid_client"
        ? "The OAuth client was rejected. Update its details and try again."
        : "Sign-in did not complete. Try connecting again.",
    InputInvalid: () => "The input does not match this tool’s schema.",
    AppProviderFailed: (error) => `${error.description} ${error.recovery.action}`,
    AppEvaluationFailed: (error) => `${error.description} ${error.recovery.action}`,
    ToolNotFound: () => "This tool is no longer available. Reload the app’s tools and try again.",
    ToolBlocked: () => "The tool's approval policy blocked this tool call. The tool did not run.",
    ToolApprovalRequired: () =>
      "The tool requires approval. The tool did not run. Approval handling is not available yet.",
    ToolPolicyFailed: () =>
      "The tool's approval policy could not be evaluated. The tool did not run. Check the policy code.",
    RequestInvalid: () => "The request is invalid. Check the input and try again.",
    ToolCallFailed: () =>
      "The tool failed. It may have already made changes. Check before trying again.",
    ToolElicitationFailed: ({ reason }) =>
      Match.value(reason).pipe(
        Match.when(
          "transaction",
          () =>
            "This operation requested input inside a database transaction. Collect input before starting the transaction.",
        ),
        Match.when(
          "unavailable",
          () =>
            "This tool needs an interactive client. Connect through MCP with native elicitation enabled.",
        ),
        Match.when(
          "invalid-request",
          () => "The tool requested an invalid input form. Check the tool code.",
        ),
        Match.when("invalid-response", () => "The response did not match the requested form."),
        Match.when(
          "transport",
          () => "The client could not complete the input request. Check the connection.",
        ),
        Match.when("expired", () => "The input request expired."),
        Match.when(
          "forbidden",
          () => "Your access changed while the tool was waiting. Ask an organization admin.",
        ),
        Match.exhaustive,
        (message) => `${message} Earlier tool actions may have completed.`,
      ),
    CredentialsError: () => "Account credentials could not be loaded or saved. Try again.",
    OrganizationIconInvalid: () => "Choose a PNG, JPG, or WebP image up to 2 MB.",
    OrganizationIconUnavailable: () => "The organization icon is unavailable. Try again.",
    OrganizationIconNotFound: () => "This organization icon is no longer available.",
    OrganizationForbidden: () =>
      "You do not have permission to do this. Ask an organization admin.",
    Unauthorized: () => "Your session has ended. Sign in again.",
    Forbidden: () => "You do not have permission to make this request.",
    AuthenticationUnavailable: () => "Sign-in is unavailable. Try again shortly.",
    AppWorkflowsActive: () =>
      "Wait for this app’s workflows to finish or terminate them before deleting it.",
    AccountWorkflowsActive: () =>
      "Wait for this account’s workflows to finish or terminate them before deleting it.",
    WorkflowFailure: (error) => `Workflow request failed (${error.reason}).`,
    AppWebhooksActive: () => "Remove this app’s webhook subscriptions before deleting it.",
    AccountWebhooksActive: () => "Remove this account’s webhook subscriptions before deleting it.",
    WebhookNotFound: () => "This webhook subscription is no longer available.",
    WebhookConflict: () =>
      "A webhook operation is in progress, or this subscription key has different settings. Check the subscription before retrying.",
    WebhookFailed: () =>
      "The webhook could not run. Check its definition, settings, and connected accounts.",
    StorageError: () => "Your data could not load. Try again.",
    AccountNotFound: () => "This account is no longer available in this organization.",
    CatalogUnavailable: () => "integrations.sh could not be reached. Try again.",
    HttpClientError: () => "Could not reach the server. Check your connection and try again.",
    SchemaError: () => "The server returned an unexpected response. Reload and try again.",
  }),
);
/** Safe copy for all expected failures. Defects never render their raw cause. */
export const appError = (cause: Cause.Cause<HostedError>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: errorMessage,
    onNone: () => "Unable to complete this request. Try again.",
  });
