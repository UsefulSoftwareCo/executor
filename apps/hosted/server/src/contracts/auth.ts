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
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {},
  { httpApiStatus: 401 },
) {}
/** Cookie-authenticated writes must come from this deployment's browser origin. */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  {},
  { httpApiStatus: 403 },
) {}
/** The session store is unavailable; this must not be treated as signed out. */
export class AuthenticationUnavailable extends Schema.TaggedError<AuthenticationUnavailable>()(
  "AuthenticationUnavailable",
  {},
  { httpApiStatus: 503 },
) {}

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
