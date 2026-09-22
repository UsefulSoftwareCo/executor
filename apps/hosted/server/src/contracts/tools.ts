import { ProfileErrors } from "@executor-js/sdk/core";
import { RequiredAction } from "./authorization.ts";
import { ExecutionLimitReached, ExecutionAdmissionUnavailable } from "./execution-admission.ts";
/** Account-dependent discovery and execution within a configured app. */
import {
  AccountNotFound,
  AccountRequired,
  AccountSelectionInvalid,
  AppEvaluationFailed,
  AppId,
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
  StorageError,
  RequestInvalid,
  ToolBlocked,
  ToolApprovalRequired,
  ToolPolicyFailed,
  ToolCallFailed,
  ToolElicitationFailed,
  ToolName,
  ToolNotFound,
  ToolPage,
} from "@executor-js/sdk/core";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
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
  DeploymentId,
  AppEvaluationFailed,
  AccountNotFound,
  AccountRequired,
  AccountSelectionInvalid,
  OAuthReconnectRequired,
] as const;
const prefix = "/api/organizations/:organization/apps/:app/tools";
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
    HttpApiEndpoint.post("call", `${prefix}/call`, {
      params,
      payload: Schema.Struct({
        tool: ToolName,
        input: Json,
        deployment: Schema.optional(DeploymentId),
        profile: Schema.optional(ProfileId),
        expectedProfileRevision: Schema.optional(ProfileRevision),
      }),
      success: Json,
      error: [
        ...discoveryErrors,
        ToolNotFound,
        InputInvalid,
        ToolCallFailed,
        ToolElicitationFailed,
        ToolBlocked,
        ToolApprovalRequired,
        ToolPolicyFailed,
        RequestInvalid,
        OrganizationForbidden,
        ExecutionLimitReached,
        ExecutionAdmissionUnavailable,
      ],
    }).annotate(RequiredAction, "run"),
  )
  .middleware(RequireOrganization);
