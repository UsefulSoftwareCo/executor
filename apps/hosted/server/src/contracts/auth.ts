import { UserFacingError } from "@executor-js/utils/user-facing-error";
import type { ApiKeyId } from "./api-keys.ts";
import type { GrantId, ResourceOrigins } from "@executor-js/mcp-auth";
import type { AuthorizationPolicy } from "@executor-js/authorization";
import type { OrganizationAccess, OrganizationReference } from "./organization.ts";
import { CurrentActor } from "@executor-js/sdk/core";
import { Context, Effect, Schema } from "effect";
import { HttpApiMiddleware } from "effect/http-api";
import type { OrganizationId, OrganizationRole, OrganizationForbidden } from "./organization.ts";

export const Viewer = Schema.Struct({
  userId: Schema.String.pipe(Schema.brand("HostedUserId")),
  sessionId: Schema.String.pipe(Schema.brand("HostedSessionId")),
  name: Schema.String,
});
export type Viewer = typeof Viewer.Type;

export const Principal = Schema.Struct({
  ...Viewer.fields,
  impersonatedBy: Schema.optionalKey(Viewer.fields.userId),
});
export type Principal = typeof Principal.Type;

const unknownApiKeyDescription =
  "This Executor API key was revoked, has expired or does not exist; unless Executor restores access by itself, create a new token on the Tokens page and connect it to the account that uses this key.";
const signInRequired = {
  title: "Sign-in required",
  description: "Executor needs a valid sign-in session to complete this action.",
  recovery: {
    action: "Sign in to Executor, then try the action again.",
    instructions:
      "Restore the user’s Executor session through the normal sign-in flow and retry the failed operation. If the session expires repeatedly, investigate session handling. Do not change the integration’s OAuth configuration to work around an Executor login failure.",
  },
};
export const Unauthorized = UserFacingError.define({
  tag: "Unauthorized",
  status: 401,
  fields: { credential: Schema.optional(Schema.Literal("apiKey")) },
  recorded: ({ credential }) =>
    credential === "apiKey" ? unknownApiKeyDescription : signInRequired.description,
  presentation: ({ credential }) =>
    credential === "apiKey"
      ? {
          title: "API key not accepted",
          description: unknownApiKeyDescription,
          recovery: {
            action:
              "Create a new token on the Tokens page, then connect it to the account that uses this key.",
            instructions:
              "The presented Executor API key is not usable. Do not retry with the same key. Ask the user to create a token on the Tokens page and connect it as an Executor API key account, with the organization's URL slug.",
          },
        }
      : signInRequired,
});
export type Unauthorized = typeof Unauthorized.Type;
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
export type Forbidden = typeof Forbidden.Type;
export const BrowserSessionOnly = Context.Reference<boolean>("hosted/BrowserSessionOnly", {
  defaultValue: () => false,
});
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
export type AuthenticationUnavailable = typeof AuthenticationUnavailable.Type;

export interface ApiAccess {
  readonly userId: string;
  readonly access: OrganizationAccess;
  readonly organizationSlug: string;
  readonly policy: AuthorizationPolicy;
  readonly key?: {
    readonly id: typeof ApiKeyId.Type;
  };
  readonly grant?: {
    readonly id: GrantId;
  };
  readonly desktop?: true;
}

export class BearerAuthentication extends Context.Service<
  BearerAuthentication,
  {
    readonly origin: string;
    readonly resourceOrigins: ResourceOrigins;
    readonly issuer: string;
    readonly authenticate: (
      headers: Headers,
      organization?: OrganizationReference,
      options?: { readonly desktop: boolean },
    ) => Effect.Effect<ApiAccess, Unauthorized | OrganizationForbidden | AuthenticationUnavailable>;
  }
>()("hosted/BearerAuthentication") {}

export class SessionAuthentication extends Context.Service<
  SessionAuthentication,
  {
    readonly origin: string;
    readonly resourceOrigins: ResourceOrigins;
    readonly oauthRedirectUri?: string | undefined;
    readonly current: (
      headers: Headers,
    ) => Effect.Effect<Principal | null, AuthenticationUnavailable>;
    readonly organization: (
      reference: OrganizationReference,
    ) => Effect.Effect<OrganizationId, AuthenticationUnavailable | OrganizationForbidden>;
    readonly organizationSlug: (
      headers: Headers,
      organization: OrganizationId,
    ) => Effect.Effect<string, AuthenticationUnavailable | OrganizationForbidden>;
    readonly membership: (
      principal: Principal,
      organization: OrganizationId,
    ) => Effect.Effect<
      {
        readonly role: typeof OrganizationRole.Type;
      },
      AuthenticationUnavailable | OrganizationForbidden
    >;
    readonly removeOrganization: (
      organization: OrganizationId,
    ) => Effect.Effect<
      { readonly logo: string | null },
      AuthenticationUnavailable | OrganizationForbidden
    >;
    readonly removeUser: (user: Viewer["userId"]) => Effect.Effect<void, AuthenticationUnavailable>;
  }
>()("hosted/SessionAuthentication") {}

export const CurrentUserId = CurrentActor;

export const callerSpanAttributes = (organization: string, user: string) => ({
  "executor.organization.id": organization,
  "executor.user.id": user,
});

export const AuthCredentialKind = Schema.Literals([
  "session",
  "oauth_access_token",
  "api_key",
  "v1_forward",
  "app_session",
  "none",
]);
export type AuthCredentialKind = typeof AuthCredentialKind.Type;

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

export class CurrentPrincipal extends Context.Service<CurrentPrincipal, Principal>()(
  "hosted/CurrentPrincipal",
) {}

export class RequireBrowserSession extends HttpApiMiddleware.Service<
  RequireBrowserSession,
  { provides: CurrentPrincipal }
>()("hosted/RequireBrowserSession", {
  error: [Unauthorized, Forbidden, AuthenticationUnavailable],
}) {}
