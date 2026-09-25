import { ApiErrorResponse, ProviderError, SkillLoadFailed } from "apps/contracts";
import { ProfileId } from "./shared.ts";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { ProfileErrors, ProfileRevision } from "./profiles.ts";
/** Existing tool call seam, using the configured app's saved accounts. Discovery design is deferred. */
import { Schema } from "effect";
import {
  ApprovalElicitation,
  ApprovalResponse,
  ElicitationFailed,
  HostedTool,
  HostedToolSummary,
  type ElicitationHandler,
} from "apps/contracts";
import { StorageError, CredentialsError, RequestInvalid } from "./shared.ts";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import {
  AccountId,
  AppId,
  ApprovalRequestId,
  Cursor,
  DeploymentId,
  Json,
  OwnerId,
  ProviderId,
  PageLimit,
  ToolName,
} from "./shared.ts";
import { AccountNotFound } from "./account.ts";
import { AccountRequired, AccountSelectionInvalid, AppNotFound, AppNotDeployed } from "./apps.ts";
import { DeploymentNotFound } from "./deployment.ts";
import { OAuthReconnectRequired } from "./oauth.ts";

/** Retention bound for a pending SDK approval and its consumed marker. */
export const ToolApprovalLimits = Schema.Struct({
  ttlMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ToolApprovalLimits = typeof ToolApprovalLimits.Type;
/** Current consume-once approval lifetime; this does not extend a live tool invocation. */
export const defaultToolApprovalLimits = ToolApprovalLimits.make({ ttlMs: 15 * 60 * 1000 });

/** Per-invocation host capabilities. These are not HTTP payloads and never enter approval storage. */
export interface ToolInvocationOptions {
  readonly elicitation?: ElicitationHandler;
}
export {
  ElicitationFailed,
  type ElicitationHandler,
  type FormElicitation,
  type ElicitationResponse,
} from "apps/contracts";

/** A running tool could not complete its user interaction. Earlier effects may have completed. */
export class ToolElicitationFailed extends Schema.TaggedError<ToolElicitationFailed>()(
  "ToolElicitationFailed",
  {
    app: AppId,
    deployment: DeploymentId,
    tool: ToolName,
    reason: ElicitationFailed.fields.reason,
  },
  { httpApiStatus: 422 },
) {}

/** One callable in an app's live definition. inputSchema is a JSON Schema document. */
export const Tool = Schema.Struct({
  ...HostedTool.fields,
  app: AppId,
  deployment: DeploymentId,
  name: ToolName,
});

export type Tool = typeof Tool.Type;

/** One page of a live catalog, evaluated using the named profile's saved selections. */
export const ToolPage = Schema.Struct({
  profile: Schema.optional(ProfileId),
  profileRevision: Schema.optional(ProfileRevision),
  deployment: DeploymentId,
  items: Schema.Array(Tool),
  next: Schema.optional(Cursor),
});

export type ToolPage = typeof ToolPage.Type;

/** One callable's name and description. Its schemas are read with tools.get. */
export const ToolSummary = Schema.Struct({
  ...HostedToolSummary.fields,
  app: AppId,
  deployment: DeploymentId,
  name: ToolName,
});

export type ToolSummary = typeof ToolSummary.Type;

/** The whole live catalog without schemas, evaluated using the named profile's saved selections. */
export const ToolIndex = Schema.Struct({
  profile: Schema.optional(ProfileId),
  profileRevision: Schema.optional(ProfileRevision),
  deployment: DeploymentId,
  items: Schema.Array(ToolSummary),
});

export type ToolIndex = typeof ToolIndex.Type;

const evaluationInstructions =
  "Reproduce tool discovery for the current app, deployment, and selected profile. Inspect safe runtime diagnostics to distinguish an unavailable build, invalid app definition, invalid account bindings, protocol failure, or app evaluation failure. This error alone does not identify which cause occurred. Do not assume an account needs reconnecting. Verify that the Tools page loads after the repair.";
const skillInstructions =
  "The app loads skills from a remote source. Read the app source to find the skill loader and its options. Do not print credentials or raw responses, and do not change accounts. If the factory awaits the loader, tools and skills both fail when that load fails. Declare it with dynamicSkills instead, such as dynamicSkills: dynamicSkills({ list: () => githubSkills(...) }), so only skill reads call it. To stop depending on the remote source, the app can bundle its skill folders and read them with folderSkills. Verify that the Skills and Tools pages load after the repair.";

/** Present a skill load failure with the loader's own message. */
const skillPresentation = ({
  reason,
  message,
  status,
}: {
  readonly reason: SkillLoadFailed["reason"];
  readonly message?: string | undefined;
  readonly status?: number | undefined;
}) => {
  const retryable =
    reason === "rate_limited" ||
    reason === "changed" ||
    (reason === "request" && (status === undefined || status >= 500));
  const action =
    reason === "rate_limited"
      ? "Wait for the rate limit to reset, then try again."
      : retryable
        ? "Try again. If this continues, check the app’s skill source."
        : "Check the app’s skill source, then try again.";
  return {
    title:
      reason === "rate_limited" ? "Skill source rate limit reached" : "Skills could not be loaded",
    description: message || "The app could not load its skills.",
    recovery: { action, instructions: skillInstructions },
    retryable,
  };
};

/** Evaluating the app's live definition failed before any tool ran. */
export const AppEvaluationFailed = UserFacingError.define({
  tag: "AppEvaluationFailed",
  status: 502,
  fields: {
    app: AppId,
    deployment: DeploymentId,
    reason: Schema.String,
    /** Present when the app's remote skill loader caused the failure. */
    skills: Schema.optional(
      Schema.Struct({
        reason: SkillLoadFailed.fields.reason,
        message: SkillLoadFailed.fields.message,
        status: SkillLoadFailed.fields.status,
      }),
    ),
  },
  presentation: ({ skills }) =>
    skills === undefined
      ? {
          title: "Tools could not be loaded",
          description: "Executor could not load this app’s tool definitions.",
          recovery: {
            action: "Try again. If this continues, copy the fix prompt to investigate the app.",
            instructions: evaluationInstructions,
          },
          retryable: true,
        }
      : skillPresentation(skills),
});
/** Parsed evaluation failure; raw runtime diagnostics never enter its presentation. */
export type AppEvaluationFailed = typeof AppEvaluationFailed.Type;

/** Recognized provider failure, enriched only with trusted selected-account metadata. */
export const AppProviderFailed = UserFacingError.define({
  tag: "AppProviderFailed",
  status: 502,
  fields: {
    app: AppId,
    deployment: DeploymentId,
    reason: ProviderError.fields.reason,
    status: ProviderError.fields.status,
    account: Schema.optional(
      Schema.Struct({ id: AccountId, label: Schema.String, provider: Schema.String }),
    ),
  },
  presentation: ({ reason, status, account }) => {
    const service = account === undefined ? "The connected service" : account.provider;
    const target = account === undefined ? "" : ` for account “${account.label}”`;
    const http = status === undefined ? "" : ` (HTTP ${status})`;
    const instructions =
      "Use the selected app and profile. Inspect only safe status codes and documented provider error codes. Do not print credentials or raw responses, switch accounts, or change authentication methods automatically. Verify tool discovery and a safe read after the repair. Before repeating a failed operation, check whether it already made changes.";
    switch (reason) {
      case "unavailable":
        return {
          title: "Service temporarily unavailable",
          description: `${service} returned a server error${http}.`,
          recovery: {
            action: "Try again. If this continues, check the service’s status and server address.",
            instructions: `The upstream returned a server error. Do not replace credentials or change authentication to address a service outage. ${instructions}`,
          },
          retryable: true,
        };
      case "unauthorized":
        return {
          title: "Authentication failed",
          description: `${service} rejected the credentials${target}${http}.`,
          recovery: {
            action:
              "Check the account’s credentials. Update its API key or reconnect its sign-in, then try again.",
            instructions: `The provider rejected authentication. This does not establish whether credentials are expired, revoked, missing, or sent incorrectly. ${instructions}`,
          },
          retryable: false,
        };
      case "forbidden":
        return {
          title: "Permission required",
          description: `${service} reported insufficient permission${target}${http}.`,
          recovery: {
            action: "Check the account’s permissions and the service’s access requirements.",
            instructions: `The provider explicitly reported insufficient permission. Do not invent required scopes or organization approval requirements. ${instructions}`,
          },
          retryable: false,
        };
      case "rate_limited":
        return {
          title: "Service rate limit reached",
          description: `${service} is limiting requests${target}${http}.`,
          recovery: {
            action: "Wait for the service’s rate limit to reset before trying again.",
            instructions: `The provider reported a rate limit. Do not replace credentials to fix it. ${instructions}`,
          },
          retryable: true,
        };
      case "rejected":
        return {
          title: "Service rejected the request",
          description: `${service} refused the request${target}${http}. We could not identify the cause from the available error details.`,
          recovery: {
            action: "Check the service’s access requirements and rate limits before trying again.",
            instructions: `A forbidden HTTP response alone does not prove invalid credentials, insufficient scopes, SSO restrictions, or a rate limit. ${instructions}`,
          },
          retryable: false,
        };
    }
  },
});
/** Safe, decoded provider failure with product recovery guidance. */
export type AppProviderFailed = typeof AppProviderFailed.Type;

/** This evaluated app does not expose the named tool. */
export class ToolNotFound extends Schema.TaggedError<ToolNotFound>()(
  "ToolNotFound",
  { app: AppId, deployment: DeploymentId, tool: ToolName },
  { httpApiStatus: 404, description: "No tool matches this name in the evaluated app." },
) {}

/** The tool input did not match its declared schema. */
export class InputInvalid extends Schema.TaggedError<InputInvalid>()(
  "InputInvalid",
  { app: AppId, deployment: DeploymentId, tool: ToolName, problems: Schema.Array(Schema.String) },
  {
    httpApiStatus: 422,
    description: "Input failed validation. Problems contain safe summaries only.",
  },
) {}

/** A tool failed after starting; its external effects may already have occurred. */
export class ToolCallFailed extends Schema.TaggedError<ToolCallFailed>()(
  "ToolCallFailed",
  {
    app: AppId,
    deployment: DeploymentId,
    tool: ToolName,
    reason: Schema.String,
    response: Schema.optional(ApiErrorResponse),
  },
  {
    httpApiStatus: 502,
    description: "The tool failed. The reason is sanitized; retry safety is not implied.",
  },
) {}

/** The tool's approval policy blocked the call before its tool body ran. */
export class ToolBlocked extends Schema.TaggedError<ToolBlocked>()(
  "ToolBlocked",
  {
    app: AppId,
    deployment: DeploymentId,
    tool: ToolName,
  },
  { httpApiStatus: 403 },
) {}

/** Adapter diagnostic for callers that cannot yet present a pending SDK approval request. */
export class ToolApprovalRequired extends Schema.TaggedError<ToolApprovalRequired>()(
  "ToolApprovalRequired",
  {
    app: AppId,
    deployment: DeploymentId,
    tool: ToolName,
  },
  { httpApiStatus: 409 },
) {}

/** The tool's approval policy could not decide. The tool did not run and author failure details remain private. */
export class ToolPolicyFailed extends Schema.TaggedError<ToolPolicyFailed>()(
  "ToolPolicyFailed",
  {
    app: AppId,
    deployment: DeploymentId,
    tool: ToolName,
  },
  { httpApiStatus: 500 },
) {}

/** A saved account identity; credentials are always resolved again on resume. */
export const InvocationAccount = Schema.Struct({
  id: AccountId,
  owner: OwnerId,
  provider: ProviderId,
  method: Schema.String,
});
/** Reviewed call with decoded arguments, exact code version and account identities. */
export const ToolInvocation = Schema.Struct({
  profile: Schema.optional(ProfileId),
  profileRevision: Schema.optional(ProfileRevision),
  app: AppId,
  owner: OwnerId,
  deployment: DeploymentId,
  tool: ToolName,
  input: Json,
  accounts: Schema.Record(
    Schema.String,
    Schema.Union([InvocationAccount, Schema.Array(InvocationAccount)]),
  ),
});
export type ToolInvocation = typeof ToolInvocation.Type;
/** Completed transport; toolError marks a framework-recognized semantic error. Value is unchanged. */
export const ToolCompleted = Schema.Struct({
  status: Schema.Literal("completed"),
  value: Json,
  toolError: Schema.optionalKey(Schema.Literal(true)),
});
/** Pending call plus the framework's MCP confirmation form. The SDK does not collect the response. */
export const ToolPending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: ApprovalRequestId,
  invocation: ToolInvocation,
  elicitation: ApprovalElicitation,
  expiresAt: Schema.Number,
});
/** Public outcome of an initial call. */
export const ToolCallResult = Schema.Union([ToolCompleted, ToolPending]);
export type ToolCallResult = typeof ToolCallResult.Type;
/** Only the consuming caller receives an execution result. Duplicates do not replay it. */
export const ToolResumeResult = Schema.Union([
  ToolCompleted,
  Schema.Struct({ status: Schema.Literal("denied"), requestId: ApprovalRequestId }),
  Schema.Struct({ status: Schema.Literal("cancelled"), requestId: ApprovalRequestId }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    requestId: ApprovalRequestId,
    reason: Schema.Literals(["expired", "context-changed", "execution-failed"]),
  }),
  Schema.Struct({ status: Schema.Literal("already-consumed"), requestId: ApprovalRequestId }),
]);
export type ToolResumeResult = typeof ToolResumeResult.Type;
/** Unknown request or a request outside an optional owner filter. */
export class ToolApprovalNotFound extends Schema.TaggedError<ToolApprovalNotFound>()(
  "ToolApprovalNotFound",
  {
    requestId: ApprovalRequestId,
  },
  { httpApiStatus: 404 },
) {}
/** Shared operation inputs. Only list's HTTP limit is string-encoded. Resume accepts no replacement invocation. */
export const ToolInputs = {
  list: Schema.Struct({
    app: AppId,
    profile: Schema.optional(ProfileId),
    expectedProfileRevision: Schema.optional(ProfileRevision),
    deployment: Schema.optional(DeploymentId),
    cursor: Schema.optional(Cursor),
    limit: Schema.optional(PageLimit),
  }),
  index: Schema.Struct({
    app: AppId,
    profile: Schema.optional(ProfileId),
    expectedProfileRevision: Schema.optional(ProfileRevision),
    deployment: Schema.optional(DeploymentId),
  }),
  get: Schema.Struct({
    app: AppId,
    profile: Schema.optional(ProfileId),
    expectedProfileRevision: Schema.optional(ProfileRevision),
    deployment: Schema.optional(DeploymentId),
    tool: ToolName,
  }),
  call: Schema.Struct({
    app: AppId,
    profile: Schema.optional(ProfileId),
    expectedProfileRevision: Schema.optional(ProfileRevision),
    deployment: Schema.optional(DeploymentId),
    tool: ToolName,
    input: Schema.optional(Json),
  }),
  pruneApprovals: Schema.Struct({ owner: Schema.optional(OwnerId) }),
  resume: Schema.Struct({
    requestId: ApprovalRequestId,
    response: ApprovalResponse,
    owner: Schema.optional(OwnerId),
  }),
};

/**
 * Calls return completion or a persisted approval request. Resume trusts the SDK caller's
 * elicitation response, pins the saved deployment and rejects changed account identities. Unknown
 * requests fail; repeated resumes report already-consumed while the marker is retained.
 */
export const ToolsGroup = HttpApiGroup.make("tools")
  .add(
    HttpApiEndpoint.get("list", "/v1/tools", {
      query: ToolInputs.list.fields,
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
        OAuthReconnectRequired,
      ],
    }).annotate(
      OpenApi.Description,
      "Inspect an app current tools. Returns the active deployment and a cursor for the next page.",
    ),
  )
  .add(
    HttpApiEndpoint.get("index", "/v1/tools/index", {
      query: ToolInputs.index.fields,
      success: ToolIndex,
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
        OAuthReconnectRequired,
      ],
    }).annotate(
      OpenApi.Description,
      "List an app's current tools without their schemas. Read one tool's schemas with get.",
    ),
  )
  .add(
    HttpApiEndpoint.get("get", "/v1/tools/get", {
      query: ToolInputs.get.fields,
      success: Tool,
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
        OAuthReconnectRequired,
        ToolNotFound,
      ],
    }).annotate(
      OpenApi.Description,
      "Describe one of an app's current tools, including its schemas.",
    ),
  )
  .add(
    HttpApiEndpoint.post("call", "/v1/tools/call", {
      payload: ToolInputs.call,
      success: ToolCallResult,
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
        ToolNotFound,
        InputInvalid,
        ToolCallFailed,
        OAuthReconnectRequired,
        ToolBlocked,
        ToolApprovalRequired,
        ToolPolicyFailed,
        ToolElicitationFailed,
        RequestInvalid,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("resume", "/v1/tools/resume", {
      payload: ToolInputs.resume,
      success: ToolResumeResult,
      error: [StorageError, CredentialsError, ToolApprovalNotFound, RequestInvalid],
    }),
  )
  .add(
    HttpApiEndpoint.post("pruneApprovals", "/v1/tools/approvals/prune", {
      payload: ToolInputs.pruneApprovals,
      success: Schema.Void,
      error: [StorageError, RequestInvalid],
    }),
  );
