import { withLegacyKeys } from "@executor-js/utils/legacy-keys";
import { RequiredAction } from "./authorization.ts";
/** Account-dependent discovery and execution within a configured app. */
import {
  AccountChoiceUnsupported,
  AccountNotFound,
  AccountRequired,
  AccountSelectionInvalid,
  AppEvaluationFailed,
  AppProviderFailed,
  AppId,
  ApprovalRequestId,
  AppNotFound,
  AppNotDeployed,
  CredentialsError,
  Cursor,
  VersionNotFound,
  VersionId,
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
import { referencedErrors } from "./tool-call-log.ts";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";

const params = { organization: OrganizationReference, app: AppId };
const discoveryErrors = [
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
  OAuthReconnectRequired,
  OAuthRenewalFailed,
  OrganizationForbidden,
] as const;
const prefix = "/api/organizations/:organization/apps/:app/tools";
// `deployment` is the former name of `version`; callers written before the rename still send it.
const versionQuery = Schema.Struct({ version: Schema.optional(VersionId) }).pipe(
  withLegacyKeys({ version: "deployment" }),
);
const callPayload = Schema.Struct({
  tool: ToolName,
  /** "query" for tools the catalog marks readOnly, otherwise "mutation". Omitted, it is read from the catalog. */
  kind: Schema.optional(ToolKind),
  input: Json,
  version: Schema.optional(VersionId),
}).pipe(withLegacyKeys({ version: "deployment" }));
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
/**
 * A failed call's errors carry its reference in the tool call log as `reference`. The dashboard
 * run adds the refusal of a bearer credential; `call` shares the run's schemas, so the API document
 * names each once.
 */
export const RunFailures = referencedErrors([Forbidden, ...callErrors]);
const [, ...callFailures] = RunFailures.errors;
export const CallFailures = {
  errors: callFailures,
  withReference: RunFailures.withReference,
  referenced: RunFailures.referenced,
};
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
      query: Schema.Struct({
        cursor: Schema.optional(Cursor),
        version: Schema.optional(VersionId),
      }).pipe(withLegacyKeys({ version: "deployment" })),
      success: ToolPage,
      error: discoveryErrors,
    }).annotate(RequiredAction, "discover"),
  )
  .add(
    HttpApiEndpoint.get("index", `${prefix}/index`, {
      params,
      query: versionQuery,
      success: ToolIndex,
      error: discoveryErrors,
    }).annotate(RequiredAction, "discover"),
  )
  .add(
    HttpApiEndpoint.get("get", `${prefix}/:tool`, {
      params: { ...params, tool: ToolName },
      query: versionQuery,
      success: Tool,
      error: [...discoveryErrors, ToolNotFound],
    }).annotate(RequiredAction, "discover"),
  )
  .add(
    HttpApiEndpoint.post("call", `${prefix}/call`, {
      params,
      payload: callPayload,
      success: Json,
      error: CallFailures.errors,
    })
      .annotate(RequiredAction, "run")
      .annotate(
        OpenApi.Description,
        "Call a tool with the caller's linked accounts. A call that fails returns its error with `reference`, the call's ID in the organization's tool call log, when the call was logged.",
      ),
  )
  .add(
    HttpApiEndpoint.post("run", `${prefix}/run`, {
      params,
      payload: callPayload,
      success: BrowserToolRun,
      error: RunFailures.errors,
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
