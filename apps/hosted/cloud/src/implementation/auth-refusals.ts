import {
  recordAuthFailure,
  recordNoCredential,
  type AuthFailureReason,
} from "@executor-js/hosted-server";
import { annotateRequestSpan } from "@executor-js/telemetry/http";
import { Effect, Option, Schema } from "effect";

const ErrorBody = Schema.fromJsonString(
  Schema.Struct({
    code: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.String),
  }),
);
const decodeError = Schema.decodeUnknownOption(ErrorBody);

const anyEndpoint: Readonly<Record<string, AuthFailureReason>> = {
  INVALID_ORIGIN: "origin_mismatch",
  MISSING_OR_NULL_ORIGIN: "origin_mismatch",
};
const otpEndpoints = [
  "/sign-in/email-otp",
  "/email-otp/verify-email",
  "/email-otp/check-verification-otp",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
  "/email-otp/reset-password",
];
const recipientEndpoints = [
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/get-invitation",
];
const byEndpoint: Readonly<Record<string, Readonly<Record<string, AuthFailureReason>>>> = {
  ...Object.fromEntries(
    otpEndpoints.map((path) => [path, { TOO_MANY_ATTEMPTS: "attempts_exceeded" as const }]),
  ),
  ...Object.fromEntries(
    recipientEndpoints.map((path) => [
      path,
      { YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: "wrong_resource" as const },
    ]),
  ),
  "/organization/invite-member": {
    YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION: "insufficient_role",
    YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE: "insufficient_role",
  },
  "/organization/cancel-invitation": {
    YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION: "insufficient_role",
  },
  "/organization/remove-member": { YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER: "insufficient_role" },
  "/organization/update": { YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_ORGANIZATION: "insufficient_role" },
  "/organization/list-members": { YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION: "not_member" },
  "/organization/get-full-organization": {
    USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION: "not_member",
  },
  "/organization/set-active": { USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION: "not_member" },
};

const basePath = "/api/auth";

export const recordAuthRefusal = (
  status: number,
  pathname: string,
  body: Uint8Array,
  headers: Headers,
) =>
  Effect.gen(function* () {
    if (status !== 401 && status !== 403) return;
    const path = pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
    const answer = Option.getOrUndefined(decodeError(new TextDecoder().decode(body)));
    const code = answer?.code ?? answer?.error;
    if (code !== undefined && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(code))
      yield* annotateRequestSpan({ "auth.failure.code": code });
    const reason =
      code === undefined
        ? undefined
        : ((Object.hasOwn(anyEndpoint, code) ? anyEndpoint[code] : undefined) ??
          (Object.hasOwn(byEndpoint, path) && Object.hasOwn(byEndpoint[path]!, code)
            ? byEndpoint[path]![code]
            : undefined));
    if (reason !== undefined) return yield* recordAuthFailure(reason);
    if (status === 401 && (code === undefined || code === "UNAUTHORIZED"))
      yield* recordNoCredential(headers);
  });
