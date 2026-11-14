import { UserFacingError } from "@executor-js/utils/user-facing-error";
import type { ApiKeyId } from "./api-keys.ts";
import type { GrantId, ResourceOrigins } from "@executor-js/mcp-auth";
import type { AuthorizationPolicy } from "@executor-js/authorization";
import type { OrganizationAccess, OrganizationReference } from "./organization.ts";
import { CurrentActor } from "@executor-js/sdk/core";
import { Context, Effect, Schema } from "effect";
import { HttpApiMiddleware } from "effect/http-api";
import type { OrganizationId, OrganizationRole, OrganizationForbidden } from "./organization.ts";

/** What `/api/viewer` returns about the signed-in user. */
export const Viewer = Schema.Struct({
  userId: Schema.String.pipe(Schema.brand("HostedUserId")),
  sessionId: Schema.String.pipe(Schema.brand("HostedSessionId")),
  name: Schema.String,
});
export type Viewer = typeof Viewer.Type;

/**
 * A hosted login identity, separate from SDK provider accounts and owners. `impersonatedBy` is
 * internal: request spans record it, and `/api/viewer` returns only the `Viewer` fields.
 */
export const Principal = Schema.Struct({
  ...Viewer.fields,
  /** The admin whose impersonation created this session, as Better Auth stored it on the row. */
  impersonatedBy: Schema.optionalKey(Viewer.fields.userId),
});
export type Principal = typeof Principal.Type;

/** No valid hosted session was supplied. */
export const Unauthorized = UserFacingError.define({
  tag: "Unauthorized",
  status: 401,
  title: "Sign-in required",
  description: "Executor needs a valid sign-in session to complete this action.",
  recovery: {
    action: "Sign in to Executor, then try the action again.",
    instructions:
      "Restore the user’s Executor session through the normal sign-in flow and retry the failed operation. If the session expires repeatedly, investigate session handling. Do not change the integration’s OAuth configuration to work around an Executor login failure.",
  },
});
/** Parsed Unauthorized failure. */
export type Unauthorized = typeof Unauthorized.Type;
/** Cookie-authenticated writes must come from this deployment's browser origin. */
export const Forbidden = UserFacingError.define({
  tag: "Forbidden",
  status: 403,
  title: "Request not allowed",
  description: "This request did not meet Executor’s access checks.",
  recovery: {
    action:
      "Open Executor directly in your browser and try again. If it still fails, copy the fix prompt into your agent to investigate.",
    instructions:
      "Check the request’s browser origin and the access requirements for the failed operation. Correct a wrong origin or context through the supported configuration. Preserve server authorization and origin validation.",
  },
});
/** Parsed Forbidden failure. */
export type Forbidden = typeof Forbidden.Type;
/**
 * An operation that refuses every Authorization header. Its handler enforces that; this annotation
 * makes the OpenAPI document list only the browser session for it.
 */
export const BrowserSessionOnly = Context.Reference<boolean>("hosted/BrowserSessionOnly", {
  defaultValue: () => false,
});
/** The session store is unavailable; this must not be treated as signed out. */
export const AuthenticationUnavailable = UserFacingError.define({
  tag: "AuthenticationUnavailable",
  status: 503,
  title: "Session check unavailable",
  description: "Executor could not verify your sign-in session.",
  recovery: {
    action:
      "Try again. If this continues, copy the fix prompt into your agent to investigate the session check.",
    instructions:
      "Check the availability of Executor’s session verification service and its dependencies. Distinguish a service failure from an expired user session. Restore the failing dependency or identify the required instance action; do not treat unavailable verification as valid authorization.",
  },
  retryable: true,
});
/** Parsed AuthenticationUnavailable failure. */
export type AuthenticationUnavailable = typeof AuthenticationUnavailable.Type;

/** Verified API identity. API keys and OAuth both retain live organization membership. */
export interface ApiAccess {
  readonly userId: string;
  readonly access: OrganizationAccess;
  readonly organizationSlug: string;
  readonly policy: AuthorizationPolicy;
  readonly key?: {
    readonly id: typeof ApiKeyId.Type;
  };
  /** The OAuth grant an agent's API token carries; absent for an API key. */
  readonly grant?: {
    readonly id: GrantId;
  };
}

/** Organization API grants; browser sessions and bearer grants never fall back to one another. */
export class BearerAuthentication extends Context.Service<
  BearerAuthentication,
  {
    /** The browser origin: dashboard, sign-in, cookies and Origin checks. */
    readonly origin: string;
    /** The origins of MCP and API OAuth resources; the first is canonical. They may differ from the browser origin. */
    readonly resourceOrigins: ResourceOrigins;
    /** The authorization server's exact issuer identifier, which discovery names. */
    readonly issuer: string;
    readonly authenticate: (
      headers: Headers,
      organization?: OrganizationReference,
    ) => Effect.Effect<ApiAccess, Unauthorized | OrganizationForbidden | AuthenticationUnavailable>;
  }
>()("hosted/BearerAuthentication") {}

/** Host-specific session lookup. Refresh belongs to Better Auth's browser endpoint. */
export class SessionAuthentication extends Context.Service<
  SessionAuthentication,
  {
    /** The browser origin: dashboard, sign-in, cookies and Origin checks. */
    readonly origin: string;
    /** The origins of MCP and API OAuth resources; the first is canonical. They may differ from the browser origin. */
    readonly resourceOrigins: ResourceOrigins;
    /** Optional provider callback relay; the browser still returns to the canonical dashboard origin. */
    readonly oauthRedirectUri?: string | undefined;
    readonly current: (
      headers: Headers,
    ) => Effect.Effect<Principal | null, AuthenticationUnavailable>;
    /** Resolve an explicit URL/API reference to its canonical storage identity. */
    readonly organization: (
      reference: OrganizationReference,
    ) => Effect.Effect<OrganizationId, AuthenticationUnavailable | OrganizationForbidden>;
    readonly organizationSlug: (
      headers: Headers,
      organization: OrganizationId,
    ) => Effect.Effect<string, AuthenticationUnavailable | OrganizationForbidden>;
    /** Read live membership for a principal already verified in this request. */
    readonly membership: (
      principal: Principal,
      organization: OrganizationId,
    ) => Effect.Effect<
      {
        readonly role: typeof OrganizationRole.Type;
      },
      AuthenticationUnavailable | OrganizationForbidden
    >;
    /** Remove the organization, its members, invitations and MCP grants. Product data is removed first. */
    readonly removeOrganization: (
      organization: OrganizationId,
    ) => Effect.Effect<
      { readonly logo: string | null },
      AuthenticationUnavailable | OrganizationForbidden
    >;
    /**
     * Remove a user with their credentials, sessions, sign-in methods and memberships. Their
     * product data is removed first; a user who is already gone is not an error.
     */
    readonly removeUser: (user: Viewer["userId"]) => Effect.Effect<void, AuthenticationUnavailable>;
  }
>()("hosted/SessionAuthentication") {}

/**
 * Verified actor for browser sessions and bearer grants; absent for background setup. It is the
 * SDK's `CurrentActor`: providing the caller here is what scopes SDK operations to them, and the
 * SDK provides the saved actor here around schedules, webhook callbacks and workflow steps.
 */
export const CurrentUserId = CurrentActor;

/**
 * What a request's spans record about its caller once the organization is known to be the
 * caller's own: the organization's opaque ID and the caller's Better Auth user ID, never an
 * email, a name or a slug. A request refused for another organization never names that one. Its
 * request span still names the verified caller's user ID and credential (`AuthCredentialKind`),
 * so refusals can be attributed to who made them.
 */
export const callerSpanAttributes = (organization: string, user: string) => ({
  "executor.organization.id": organization,
  "executor.user.id": user,
});

/**
 * The kind of credential a request presented, as its request span records it
 * (`auth.credential.kind`): a browser session cookie, an OAuth access token, a personal access
 * token (API key), a request v1 forwarded with its signed bearer, an app page's session, or none.
 */
export const AuthCredentialKind = Schema.Literals([
  "session",
  "oauth_access_token",
  "api_key",
  "v1_forward",
  "app_session",
  "none",
]);
export type AuthCredentialKind = typeof AuthCredentialKind.Type;

/**
 * Why a request was refused with 401 or 403, as its request span records it
 * (`auth.failure.reason`). Each value is decided where the check fails, from the check's own state:
 *
 * - `missing`: no credential was presented.
 * - `malformed`: a credential or organization header was presented in a form no check accepts.
 * - `unknown`: no stored credential matches it (a token, key, session or app session). A session
 *   that expired or was signed out is no longer stored, so it is `unknown` too.
 * - `expired`: the stored credential, or the session it belongs to, has expired.
 * - `revoked`: the credential, its grant, client, connection or user was revoked, disabled or
 *   removed.
 * - `wrong_resource`: a live credential issued for another resource, audience, connection or app.
 * - `attempts_exceeded`: too many wrong one-time codes; the code accepts no more attempts.
 * - `origin_mismatch`: a browser request from another origin.
 * - `bearer_not_allowed`: a browser-only operation was sent an API credential.
 * - `organization_required`: an unpinned key named no organization where one is needed.
 * - `organization_mismatch`: the request names a different organization than its credential's.
 * - `organization_not_found`: the organization the request names does not exist, is ambiguous, or
 *   is being removed.
 * - `not_member`: the verified caller is not a member of the organization.
 * - `insufficient_scope`: the credential's grant does not permit this action, app or tool.
 * - `insufficient_role`: the caller's role does not permit this administrative action.
 * - `resource_denied`: a member was refused by a check on the resource itself, such as an app or
 *   app not shared with them or another member's account.
 * - `app_not_found`: an app page's host or app does not exist.
 * - `unclassified`: a 401 or 403 that no check above recorded; it marks a gap to classify.
 */
export const AuthFailureReason = Schema.Literals([
  "missing",
  "malformed",
  "unknown",
  "expired",
  "revoked",
  "wrong_resource",
  "attempts_exceeded",
  "origin_mismatch",
  "bearer_not_allowed",
  "organization_required",
  "organization_mismatch",
  "organization_not_found",
  "not_member",
  "insufficient_scope",
  "insufficient_role",
  "resource_denied",
  "app_not_found",
  "unclassified",
]);
export type AuthFailureReason = typeof AuthFailureReason.Type;

/** Request-local identity supplied only after successful authentication. */
export class CurrentPrincipal extends Context.Service<CurrentPrincipal, Principal>()(
  "hosted/CurrentPrincipal",
) {}

/** Hosted identity boundary; resource permissions remain separate product checks. */
export class RequireBrowserSession extends HttpApiMiddleware.Service<
  RequireBrowserSession,
  { provides: CurrentPrincipal }
>()("hosted/RequireBrowserSession", {
  error: [Unauthorized, Forbidden, AuthenticationUnavailable],
}) {}
