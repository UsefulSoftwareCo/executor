import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { UserStoreError, WorkOSError } from "./errors";
import { SessionAuth } from "./middleware";

const AuthUser = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});

const AuthOrganization = Schema.Struct({
  id: Schema.String,
  handle: Schema.String,
  name: Schema.String,
});

const AuthMeResponse = Schema.Struct({
  user: AuthUser,
  /** Memberships, with the org `handle` URL routes use. Sorted alphabetically. */
  organizations: Schema.Array(AuthOrganization),
});

const AuthOrganizationsResponse = Schema.Struct({
  organizations: Schema.Array(AuthOrganization),
});

const CreateOrganizationBody = Schema.Struct({
  name: Schema.String,
});

const CreateOrganizationResponse = Schema.Struct({
  id: Schema.String,
  handle: Schema.String,
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

export const AUTH_PATHS = {
  login: "/api/auth/login",
  logout: "/api/auth/logout",
  callback: "/api/auth/callback",
} as const;

const AuthErrors = [UserStoreError, WorkOSError] as const;

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
  .middleware(SessionAuth) {}
