import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { UserStoreError, WorkOSError } from "./errors";
import { NoOrganization } from "@executor-js/api/server";
import { SessionAuth } from "./middleware";

const AuthUser = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});

const AuthOrganization = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** URL slug for org-prefixed console paths (`/<slug>/policies`). */
  slug: Schema.String,
});

const AuthMeResponse = Schema.Struct({
  user: AuthUser,
  organization: Schema.NullOr(AuthOrganization),
});

const AuthOrganizationSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
});

const AuthOrganizationsResponse = Schema.Struct({
  organizations: Schema.Array(AuthOrganizationSummary),
  activeOrganizationId: Schema.NullOr(Schema.String),
});

const CreateOrganizationBody = Schema.Struct({
  name: Schema.String,
});

const CreateOrganizationResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
});

// CLI device-login discovery (`executor login`). Tells the CLI where to run
// the OAuth 2.0 Device Authorization Grant (RFC 8628) and which public client
// to use. The CLI hits these provider endpoints directly, gets a WorkOS access
// token (a JWT), and sends it as a Bearer to the `/api/*` plane.
const CliLoginResponse = Schema.Struct({
  provider: Schema.Literal("workos"),
  deviceAuthorizationEndpoint: Schema.String,
  tokenEndpoint: Schema.String,
  clientId: Schema.String,
});

// `state` is optional — some WorkOS-initiated redirects arrive at the
// callback without the state we set on /auth/login. The CSRF check is
// only enforced when state is present (see callback handler).
const AuthCallbackSearch = Schema.Struct({
  code: Schema.String,
  state: Schema.optional(Schema.String),
});

// Where to send the user after the callback completes (the /login page passes
// the path the SSR auth gate captured). Validated server-side to same-origin
// relative paths before use.
const AuthLoginSearch = Schema.Struct({
  returnTo: Schema.optional(Schema.String),
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
  slug: Schema.String,
});

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
} as const;

const AuthErrors = [UserStoreError, WorkOSError] as const;
const McpApprovalErrors = [
  NoOrganization,
  McpExecutionNotFoundError,
  McpSessionForbiddenError,
] as const;

/** Public auth endpoints — no authentication required */
export class CloudAuthPublicApi extends HttpApiGroup.make("cloudAuthPublic")
  .add(HttpApiEndpoint.get("login", "/auth/login", { query: AuthLoginSearch }))
  .add(
    HttpApiEndpoint.get("callback", "/auth/callback", {
      query: AuthCallbackSearch,
      error: AuthErrors,
    }),
  )
  .add(HttpApiEndpoint.get("cliLogin", "/auth/cli-login", { success: CliLoginResponse })) {}

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
