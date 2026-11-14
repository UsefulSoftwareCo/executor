/**
 * The closed vocabularies the Better Auth security audit (`auth-audit.ts`) reads: which endpoints
 * it audits and how, the failure codes a record may name, the decoders for the request body
 * fields and stored answers it reads, and how an endpoint's answer decodes to its outcome.
 * Anything outside them is never recorded as given.
 */
import { PASSKEY_ERROR_CODES } from "@better-auth/passkey";
import { BASE_ERROR_CODES } from "better-auth";
import { APIError } from "better-auth/api";
import { Option, Schema } from "effect";
import { auditFailureCodes } from "@executor-js/hosted-server";
import { oauthErrorCodes } from "./auth-observability.ts";

/**
 * How each sign-in endpoint signs in. A session it creates is a success. Other endpoints also set
 * a new session, such as `/get-session` when it extends one, so only these count as sign-ins.
 */
export const signIns: Readonly<Record<string, string>> = {
  "/sign-in/email-otp": "email_otp",
  "/sign-in/social": "social",
  "/callback/:id": "social",
  "/oauth-proxy-callback": "social",
  "/passkey/verify-authentication": "passkey",
  "/sign-in/sso": "sso",
  "/sso/callback": "sso",
  "/sso/callback/:providerId": "sso",
  "/sso/saml2/sp/acs/:providerId": "sso",
  "/v1-handoff/session": "v1_handoff",
};
/** Endpoints that check a one-time code outside sign-in, where a wrong code is the event. */
export const otpChecks = new Set([
  "/email-otp/verify-email",
  "/email-otp/check-verification-otp",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
  "/email-otp/reset-password",
]);
/** Endpoints that end sessions. */
export const revocations = new Set([
  "/sign-out",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
]);
/** The other audited endpoints: API keys, members, invitations, OAuth clients, impersonation. */
const actions = new Set([
  "/api-key/create",
  "/api-key/delete",
  "/organization/update-member-role",
  "/organization/remove-member",
  "/organization/invite-member",
  "/organization/accept-invitation",
  "/organization/cancel-invitation",
  "/oauth2/register",
  "/oauth2/consent",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
]);
export const audited = (path: string | undefined) =>
  path !== undefined &&
  (path in signIns || otpChecks.has(path) || revocations.has(path) || actions.has(path));

/**
 * The failure codes these endpoints answer with: Better Auth's own and its passkey plugin's, the
 * codes of the email-code, organization and API key plugins they raise, the OAuth errors a sign-in
 * returns with, and an HTTP status where the answer carries no code. Anything else is `other`.
 */
export const failureOf = auditFailureCodes([
  ...Object.keys(BASE_ERROR_CODES),
  ...Object.keys(PASSKEY_ERROR_CODES),
  // Email codes.
  "OTP_EXPIRED",
  "INVALID_OTP",
  "TOO_MANY_ATTEMPTS",
  // Organization members and invitations.
  "MEMBER_NOT_FOUND",
  "NO_ACTIVE_ORGANIZATION",
  "ORGANIZATION_NOT_FOUND",
  "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED",
  "ROLE_NOT_FOUND",
  "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
  "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION",
  "INVITATION_NOT_FOUND",
  "INVITATION_LIMIT_REACHED",
  "INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION",
  "EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION",
  "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER",
  "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER",
  "YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION",
  "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION",
  "YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE",
  "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
  "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
  // API keys.
  "KEY_NOT_FOUND",
  "UNAUTHORIZED_SESSION",
  "INVALID_NAME_LENGTH",
  "NAME_REQUIRED",
  // Impersonation.
  "YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS",
  "YOU_CANNOT_IMPERSONATE_ADMINS",
  ...oauthErrorCodes,
  ...Array.from({ length: 200 }, (_, offset) => String(400 + offset)),
]);

const Id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
/**
 * The request body fields the endpoints read, each decoded on its own. Better Auth ignores a field
 * an endpoint does not take, so one such field's value must not hide another's.
 */
export const decodeKeyId = Schema.decodeUnknownOption(Schema.Struct({ keyId: Id }));
export const decodeRole = Schema.decodeUnknownOption(
  Schema.Struct({ role: Schema.Literals(["owner", "admin", "member"]) }),
);
export const decodeAccept = Schema.decodeUnknownOption(Schema.Struct({ accept: Schema.Boolean }));
export const decodeOAuthQuery = Schema.decodeUnknownOption(
  Schema.Struct({ oauth_query: Schema.String }),
);
/** The stored records the endpoints answer with. */
const Returned = Schema.Struct({
  id: Schema.optionalKey(Id),
  client_id: Schema.optionalKey(Id),
  organizationId: Schema.optionalKey(Id),
  metadata: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ organization: Schema.optionalKey(Id) })),
  ),
  member: Schema.optionalKey(Schema.Struct({ id: Id, organizationId: Id })),
  invitation: Schema.optionalKey(Schema.Struct({ id: Id, organizationId: Id })),
});
const ErrorBody = Schema.Struct({ code: Schema.optionalKey(Schema.String) });
export const decodeReturned = Schema.decodeUnknownOption(Returned);
const decodeError = Schema.decodeUnknownOption(ErrorBody);
export const decodeId = Schema.decodeUnknownOption(Id);

/** A signed-in session, as a hook or the endpoint's authentication loaded it. */
export interface Session {
  readonly user: { readonly id: string };
  readonly session: { readonly id: string; readonly impersonatedBy?: string | null | undefined };
}
/** The structural part of Better Auth's hook context this module reads. */
export interface HookContext {
  readonly path?: string | undefined;
  readonly body?: unknown;
  readonly context: {
    readonly returned?: unknown;
    readonly newSession?:
      | {
          readonly user: { readonly id: string };
          readonly session: { readonly impersonatedBy?: string | null | undefined };
        }
      | null
      | undefined;
    readonly session?: Session | null | undefined;
    readonly responseHeaders?: Headers | undefined;
  };
}

/**
 * The endpoint's outcome: failure with Better Auth's error code, or the `error` a redirect carries
 * back to the browser; success otherwise. A redirect is an `APIError` whatever it means.
 */
export const outcome = (ctx: HookContext) => {
  const returned = ctx.context.returned;
  if (returned instanceof APIError && returned.statusCode >= 400)
    return failureOf(
      Option.getOrUndefined(decodeError(returned.body))?.code ?? String(returned.statusCode),
    );
  if (returned instanceof Response && returned.status >= 400)
    return failureOf(String(returned.status));
  const location =
    (returned instanceof APIError ? new Headers(returned.headers).get("location") : null) ??
    ctx.context.responseHeaders?.get("location") ??
    null;
  const error =
    location === null
      ? null
      : URL.parse(location, "https://auth.invalid")?.searchParams.get("error");
  return error === null || error === undefined ? undefined : failureOf(error);
};
