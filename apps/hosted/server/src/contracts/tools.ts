import { ProfileErrors } from "@executor-js/sdk/core";
import { RequiredAction } from "./authorization.ts";
/** Account-dependent discovery and execution within a configured app. */
import {
  AccountNotFound,
  AccountRequired,
  AccountSelectionInvalid,
  AppEvaluationFailed,
  AppProviderFailed,
  AppId,
  ApprovalRequestId,
  ProfileId,
  ProfileRevision,
  AppNotFound,
  AppNotDeployed,
  CredentialsError,
  Cursor,
  DeploymentNotFound,
  DeploymentId,
  InputInvalid,
  Json,
  OAuthReconnectRequired,
  OAuthRenewalFailed,
  StorageError,
  RequestInvalid,
  ToolBlocked,
  ToolApprovalRequired,
  ToolPolicyFailed,
  ToolCallFailed,
  ToolElicitationFailed,
  ToolName,
  ToolIndex,
  ToolNotFound,
  ToolListingTimedOut,
  ToolKind,
  ToolKindMismatch,
  ToolPage,
  Tool,
} from "@executor-js/sdk/core";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  BrowserApprovalAnswer,
  BrowserApprovalView,
  BrowserToolRun,
  BrowserToolRunAnswer,
  ToolRunApprovalRefused,
} from "@executor-js/mcp/browser";
import { BrowserSessionOnly, Forbidden } from "./auth.ts";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";

const params = { organization: OrganizationReference, app: AppId };
const discoveryErrors = [
  ...ProfileErrors,
  StorageError,
  CredentialsError,
  AppNotFound,
  AppNotDeployed,
  DeploymentNotFound,
  AppEvaluationFailed,
  ToolListingTimedOut,
  AppProviderFailed,
  AccountNotFound,
  AccountRequired,
  AccountSelectionInvalid,
  OAuthReconnectRequired,
  OAuthRenewalFailed,
] as const;
const prefix = "/api/organizations/:organization/apps/:app/tools";
const callPayload = Schema.Struct({
  tool: ToolName,
  /** "query" for tools the catalog marks readOnly, otherwise "mutation". Omitted, it is read from the catalog. */
  kind: Schema.optional(ToolKind),
  input: Json,
  deployment: Schema.optional(DeploymentId),
  profile: Schema.optional(ProfileId),
  expectedProfileRevision: Schema.optional(ProfileRevision),
});
const callErrors = [
  ...discoveryErrors,
  ToolNotFound,
  ToolKindMismatch,
  InputInvalid,
  ToolCallFailed,
  ToolElicitationFailed,
  ToolBlocked,
  ToolApprovalRequired,
  ToolPolicyFailed,
  RequestInvalid,
  OrganizationForbidden,
] as const;
const approval = { ...params, requestId: ApprovalRequestId };
const reviewErrors = [
  ...discoveryErrors,
  ToolNotFound,
  RequestInvalid,
  OrganizationForbidden,
  Forbidden,
  ToolRunApprovalRefused,
] as const;
/** Members may discover tools; execution requires an administrator in the handler. */
export const HostedTools = HttpApiGroup.make("tools")
  .add(
    HttpApiEndpoint.get("list", prefix, {
      params,
      query: {
        cursor: Schema.optional(Cursor),
        deployment: Schema.optional(DeploymentId),
        profile: Schema.optional(ProfileId),
        expectedProfileRevision: Schema.optional(ProfileRevision),
      },
      success: ToolPage,
      error: discoveryErrors,
    }).annotate(RequiredAction, "discover"),
  )
  .add(
    HttpApiEndpoint.get("index", `${prefix}/index`, {
      params,
      query: {
        deployment: Schema.optional(DeploymentId),
        profile: Schema.optional(ProfileId),
        expectedProfileRevision: Schema.optional(ProfileRevision),
      },
      success: ToolIndex,
      error: discoveryErrors,
    }).annotate(RequiredAction, "discover"),
  )
  .add(
    HttpApiEndpoint.get("get", `${prefix}/:tool`, {
      params: { ...params, tool: ToolName },
      query: {
        deployment: Schema.optional(DeploymentId),
        profile: Schema.optional(ProfileId),
        expectedProfileRevision: Schema.optional(ProfileRevision),
      },
      success: Tool,
      error: [...discoveryErrors, ToolNotFound],
    }).annotate(RequiredAction, "discover"),
  )
  .add(
    HttpApiEndpoint.post("call", `${prefix}/call`, {
      params,
      payload: callPayload,
      success: Json,
      error: callErrors,
    }).annotate(RequiredAction, "run"),
  )
  .add(
    HttpApiEndpoint.post("run", `${prefix}/run`, {
      params,
      payload: callPayload,
      success: BrowserToolRun,
      error: [...callErrors, Forbidden],
    })
      .annotate(RequiredAction, "run")
      .annotate(BrowserSessionOnly, true)
      .annotate(
        OpenApi.Description,
        "Run a tool as the signed-in person, from their browser session only; bearer credentials are refused and use call. A call that needs approval returns a request that only this person's dashboard can review.",
      ),
  )
  .add(
    HttpApiEndpoint.get("approval", `${prefix}/approvals/:requestId`, {
      params: approval,
      success: BrowserApprovalView,
      error: reviewErrors,
    })
      .annotate(RequiredAction, "run")
      .annotate(BrowserSessionOnly, true)
      .annotate(
        OpenApi.Description,
        "Show the signed-in person the saved call their own dashboard run is waiting to approve. Browser session only. Approvals from MCP, schedules, API calls or another person's run are refused.",
      ),
  )
  .add(
    HttpApiEndpoint.post("answer", `${prefix}/approvals/:requestId`, {
      params: approval,
      payload: BrowserApprovalAnswer,
      success: BrowserToolRunAnswer,
      error: [...reviewErrors, CredentialsError],
    })
      .annotate(RequiredAction, "run")
      .annotate(BrowserSessionOnly, true)
      .annotate(
        OpenApi.Description,
        "Approve or decline the signed-in person's own dashboard run. Browser session only. Approval runs the saved call and returns its result; approvals from other flows are refused.",
      ),
  )
  .middleware(RequireOrganization);
