import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { ApiKeyManagementError } from "./api-key-errors";
import { UserStoreError, WorkOSError } from "./errors";
import { NoOrganization, SessionAuth } from "./middleware";

const AuthUser = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});

const AuthOrganization = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const AuthMeResponse = Schema.Struct({
  user: AuthUser,
  organization: Schema.NullOr(AuthOrganization),
});

const AuthOrganizationSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const AuthOrganizationsResponse = Schema.Struct({
  organizations: Schema.Array(AuthOrganizationSummary),
  activeOrganizationId: Schema.NullOr(Schema.String),
});

const SwitchOrganizationBody = Schema.Struct({
  organizationId: Schema.String,
});

const CreateOrganizationBody = Schema.Struct({
  name: Schema.String,
});

const CreateOrganizationResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

// `state` is optional — some WorkOS-initiated redirects arrive at the
// callback without the state we set on /auth/login. The CSRF check is
// only enforced when state is present (see callback handler).
const AuthCallbackSearch = Schema.Struct({
  code: Schema.String,
  state: Schema.optional(Schema.String),
});

const PendingInvitationInviter = Schema.Struct({
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
});

const PendingInvitation = Schema.Struct({
  id: Schema.String,
  organizationId: Schema.String,
  organizationName: Schema.String,
  createdAt: Schema.String,
  inviter: Schema.NullOr(PendingInvitationInviter),
});

const PendingInvitationsResponse = Schema.Struct({
  invitations: Schema.Array(PendingInvitation),
});

const AcceptInvitationBody = Schema.Struct({
  invitationId: Schema.String,
});

const AcceptInvitationResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const ApiKeySummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  obfuscatedValue: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
});

const ApiKeysResponse = Schema.Struct({
  apiKeys: Schema.Array(ApiKeySummary),
});

const CreateApiKeyBody = Schema.Struct({
  name: Schema.String,
});

const CreatedApiKeyResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  obfuscatedValue: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  value: Schema.String,
});

const ApiKeyParams = { apiKeyId: Schema.String };

const McpSessionExecutionParams = {
  mcpSessionId: Schema.String,
  executionId: Schema.String,
};

const ResumeMcpExecutionBody = Schema.Struct({
  action: Schema.Literals(["accept", "decline", "cancel"]),
  content: Schema.optional(Schema.Unknown),
});

const McpPausedExecutionResponse = Schema.Struct({
  text: Schema.String,
  structured: Schema.Unknown,
});

const McpResumeCompletedResponse = Schema.Struct({
  status: Schema.Literal("completed"),
  text: Schema.String,
  structured: Schema.Unknown,
  isError: Schema.Boolean,
});

const McpResumePausedResponse = Schema.Struct({
  status: Schema.Literal("paused"),
  text: Schema.String,
  structured: Schema.Unknown,
});

const McpResumeExecutionResponse = Schema.Union([
  McpResumeCompletedResponse,
  McpResumePausedResponse,
]);

export class McpExecutionNotFoundError extends Schema.TaggedErrorClass<McpExecutionNotFoundError>()(
  "McpExecutionNotFoundError",
  {
    executionId: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class McpSessionForbiddenError extends Schema.TaggedErrorClass<McpSessionForbiddenError>()(
  "McpSessionForbiddenError",
  {
    mcpSessionId: Schema.String,
  },
  { httpApiStatus: 403 },
) {}

export const AUTH_PATHS = {
  login: "/api/auth/login",
  logout: "/api/auth/logout",
  callback: "/api/auth/callback",
  switchOrganization: "/api/auth/switch-organization",
} as const;

const AuthErrors = [UserStoreError, WorkOSError] as const;
const ApiKeyErrors = [ApiKeyManagementError, NoOrganization, UserStoreError, WorkOSError] as const;
const McpApprovalErrors = [
  NoOrganization,
  McpExecutionNotFoundError,
  McpSessionForbiddenError,
] as const;

/** Public auth endpoints — no authentication required */
export class CloudAuthPublicApi extends HttpApiGroup.make("cloudAuthPublic")
  .add(HttpApiEndpoint.get("login", "/auth/login"))
  .add(
    HttpApiEndpoint.get("callback", "/auth/callback", {
      query: AuthCallbackSearch,
      error: AuthErrors,
    }),
  ) {}

/** Session auth endpoints — require a logged-in user, may not have an org */
export class CloudAuthApi extends HttpApiGroup.make("cloudAuth")
  .add(
    HttpApiEndpoint.get("me", "/auth/me", {
      success: AuthMeResponse,
      error: AuthErrors,
    }),
  )
  .add(HttpApiEndpoint.post("logout", "/auth/logout"))
  .add(
    HttpApiEndpoint.get("organizations", "/auth/organizations", {
      success: AuthOrganizationsResponse,
      error: WorkOSError,
    }),
  )
  .add(
    HttpApiEndpoint.post("switchOrganization", "/auth/switch-organization", {
      payload: SwitchOrganizationBody,
      error: WorkOSError,
    }),
  )
  .add(
    HttpApiEndpoint.post("createOrganization", "/auth/create-organization", {
      payload: CreateOrganizationBody,
      success: CreateOrganizationResponse,
      error: AuthErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("pendingInvitations", "/auth/pending-invitations", {
      success: PendingInvitationsResponse,
      error: WorkOSError,
    }),
  )
  .add(
    HttpApiEndpoint.post("acceptInvitation", "/auth/accept-invitation", {
      payload: AcceptInvitationBody,
      success: AcceptInvitationResponse,
      error: AuthErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("listApiKeys", "/auth/api-keys", {
      success: ApiKeysResponse,
      error: ApiKeyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("createApiKey", "/auth/api-keys", {
      payload: CreateApiKeyBody,
      success: CreatedApiKeyResponse,
      error: ApiKeyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("revokeApiKey", "/auth/api-keys/:apiKeyId", {
      params: ApiKeyParams,
      error: ApiKeyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getMcpPaused", "/mcp-sessions/:mcpSessionId/executions/:executionId", {
      params: McpSessionExecutionParams,
      success: McpPausedExecutionResponse,
      error: McpApprovalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post(
      "resumeMcpExecution",
      "/mcp-sessions/:mcpSessionId/executions/:executionId/resume",
      {
        params: McpSessionExecutionParams,
        payload: ResumeMcpExecutionBody,
        success: McpResumeExecutionResponse,
        error: McpApprovalErrors,
      },
    ),
  )
  .middleware(SessionAuth) {}
