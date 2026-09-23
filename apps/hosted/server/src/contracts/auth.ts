import { UserFacingError } from "@executor-js/utils/user-facing-error";
import type { ApiKeyId } from "./api-keys.ts";
import type { AuthorizationPolicy } from "@executor-js/authorization";
import type { OrganizationAccess, OrganizationReference } from "./organization.ts";
import { Context, Effect, Schema } from "effect";
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import type { OrganizationId, OrganizationRole, OrganizationForbidden } from "./organization.ts";

/** A hosted login identity, separate from SDK provider accounts and owners. */
export const Principal = Schema.Struct({
  userId: Schema.String.pipe(Schema.brand("HostedUserId")),
  sessionId: Schema.String.pipe(Schema.brand("HostedSessionId")),
  name: Schema.String,
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
}

/** Organization API grants; browser sessions and bearer grants never fall back to one another. */
export class ApiAuthentication extends Context.Service<
  ApiAuthentication,
  {
    readonly origin: string;
    readonly authenticate: (
      headers: Headers,
      organization?: OrganizationReference,
    ) => Effect.Effect<ApiAccess, Unauthorized | OrganizationForbidden | AuthenticationUnavailable>;
  }
>()("hosted/ApiAuthentication") {}

/** Host-specific session lookup. Refresh belongs to Better Auth's browser endpoint. */
export class Authentication extends Context.Service<
  Authentication,
  {
    readonly origin: string;
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
    readonly membership: (
      headers: Headers,
      organization: OrganizationId,
    ) => Effect.Effect<
      {
        readonly role: typeof OrganizationRole.Type;
        readonly headers: Headers;
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
  }
>()("hosted/Authentication") {}

/** Verified actor for both browser sessions and bearer grants; absent for background setup. */
export const CurrentUserId = Context.Reference<string | undefined>("hosted/CurrentUserId", {
  defaultValue: () => undefined,
});

/** Request-local identity supplied only after successful authentication. */
export class CurrentPrincipal extends Context.Service<CurrentPrincipal, Principal>()(
  "hosted/CurrentPrincipal",
) {}

/** Hosted identity boundary; resource permissions remain separate product checks. */
export class RequireUser extends HttpApiMiddleware.Service<
  RequireUser,
  { provides: CurrentPrincipal }
>()("hosted/RequireUser", {
  error: [Unauthorized, Forbidden, AuthenticationUnavailable],
}) {}
