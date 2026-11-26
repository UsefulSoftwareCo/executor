import { PASSKEY_ERROR_CODES } from "@better-auth/passkey";
import { BASE_ERROR_CODES } from "better-auth";
import { APIError } from "better-auth/api";
import { Option, Schema } from "effect";
import { auditFailureCodes } from "@executor-js/hosted-server";
import { oauthErrorCodes } from "./auth-observability.ts";

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
export const otpChecks = new Set([
  "/email-otp/verify-email",
  "/email-otp/check-verification-otp",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
  "/email-otp/reset-password",
]);
export const revocations = new Set([
  "/sign-out",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
]);
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

export const failureOf = auditFailureCodes([
  ...Object.keys(BASE_ERROR_CODES),
  ...Object.keys(PASSKEY_ERROR_CODES),
  "OTP_EXPIRED",
  "INVALID_OTP",
  "TOO_MANY_ATTEMPTS",
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
  "KEY_NOT_FOUND",
  "UNAUTHORIZED_SESSION",
  "INVALID_NAME_LENGTH",
  "NAME_REQUIRED",
  "YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS",
  "YOU_CANNOT_IMPERSONATE_ADMINS",
  ...oauthErrorCodes,
  ...Array.from({ length: 200 }, (_, offset) => String(400 + offset)),
]);

const Id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
export const decodeKeyId = Schema.decodeUnknownOption(Schema.Struct({ keyId: Id }));
export const decodeRole = Schema.decodeUnknownOption(
  Schema.Struct({ role: Schema.Literals(["owner", "admin", "member"]) }),
);
export const decodeAccept = Schema.decodeUnknownOption(Schema.Struct({ accept: Schema.Boolean }));
export const decodeOAuthQuery = Schema.decodeUnknownOption(
  Schema.Struct({ oauth_query: Schema.String }),
);
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

export interface Session {
  readonly user: { readonly id: string };
  readonly session: { readonly id: string; readonly impersonatedBy?: string | null | undefined };
}
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
