/**
 * What a request's span records about its caller, wherever in the request the check that
 * learns it runs. No credential value, hash or prefix is ever recorded: only its kind and an
 * identifier that is not a secret (an API key's ID, an OAuth client's ID, a session's row ID).
 */
import { annotateRequestSpan, currentRequestSpan } from "@executor-js/telemetry/http";
import { Effect, Option, Schema } from "effect";
import { HttpEffect, type HttpServerResponse } from "effect/http";
import {
  callerSpanAttributes,
  type AuthCredentialKind,
  type AuthFailureReason,
  type Principal,
} from "../contracts/auth.ts";
import { OrganizationForbidden } from "../contracts/organization.ts";

/**
 * Name the caller's own organization and the caller, by their opaque IDs, on the current span and
 * on the request's span. Call it only once the organization is known to be the caller's.
 */
export const recordCaller = (organization: string, user: string) => {
  const attributes = callerSpanAttributes(organization, user);
  return Effect.andThen(Effect.annotateCurrentSpan(attributes), annotateRequestSpan(attributes));
};

/**
 * Name the credential the request presented on its request span: its kind as soon as it is known,
 * its non-secret ID once it is found, and its user once it is verified. A later refusal, such as
 * for an organization the user does not belong to, keeps them.
 */
export const recordCredential = (credential: {
  readonly kind: AuthCredentialKind;
  readonly id?: string | undefined;
  readonly user?: string | undefined;
  /** The admin whose impersonation created the session, from the stored session row. */
  readonly impersonatedBy?: string | undefined;
}) =>
  annotateRequestSpan({
    "auth.credential.kind": credential.kind,
    ...(credential.id === undefined ? {} : { "auth.credential.id": credential.id }),
    ...(credential.user === undefined ? {} : { "executor.user.id": credential.user }),
    ...(credential.impersonatedBy === undefined
      ? {}
      : { "auth.impersonated_by": credential.impersonatedBy }),
  });

/**
 * Name a verified session on the request span. In a session an admin's impersonation created,
 * `executor.user.id` is the impersonated user and `auth.impersonated_by` the admin.
 */
export const recordSessionCredential = (principal: Principal) =>
  recordCredential({
    kind: "session",
    id: principal.sessionId,
    user: principal.userId,
    impersonatedBy: principal.impersonatedBy,
  });

/**
 * Name why the request was refused on its request span (`auth.failure.reason`). A request that
 * checks its credential again, such as each tool call inside MCP `execute`, keeps the last refusal.
 */
export const recordAuthFailure = (reason: AuthFailureReason) =>
  annotateRequestSpan({ "auth.failure.reason": reason });

/**
 * Record why no session was found: `missing` with no session cookie, else `unknown` (a signed-out,
 * expired or forged session). The cookie is a hint here only; Better Auth decided the session.
 */
export const recordNoSession = (headers: Headers) =>
  presentsSessionCookie(headers)
    ? Effect.andThen(recordCredential({ kind: "session" }), recordAuthFailure("unknown"))
    : Effect.andThen(recordCredential({ kind: "none" }), recordAuthFailure("missing"));

/** Whether the request carries a session cookie, valid or not, under any cookie prefix. */
const presentsSessionCookie = (headers: Headers) =>
  /(?:^|;)\s*[^=;\s]*\.session_token=/u.test(headers.get("cookie") ?? "");

/**
 * Record `missing` when the request presented no credential at all: no session cookie and no
 * Authorization header. A request that presented one records nothing here.
 */
export const recordNoCredential = (headers: Headers) =>
  headers.has("authorization") || presentsSessionCookie(headers)
    ? Effect.void
    : Effect.andThen(recordCredential({ kind: "none" }), recordAuthFailure("missing"));

/** Fail with `error`, recording `reason` first. */
export const refuse = <E>(reason: AuthFailureReason, error: E) =>
  Effect.andThen(recordAuthFailure(reason), Effect.fail(error));

/** Record `reason` when the check fails with `OrganizationForbidden`; the failure is unchanged. */
export const refusedAs =
  (reason: AuthFailureReason) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.tapError(effect, (error) =>
      Schema.is(OrganizationForbidden)(error) ? recordAuthFailure(reason) : Effect.void,
    );

/**
 * Give every 401 and 403 a reason. A refusal that no check named is `unclassified`, except a 403
 * after the caller's membership was confirmed (`executor.organization.id`), which only a check on
 * the resource itself can produce: `resource_denied`. Apply it in the request's span.
 */
export const recordUnclassifiedRefusals = <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const span = yield* currentRequestSpan;
    if (Option.isSome(span))
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.sync(() => {
          const refused = response.status === 401 || response.status === 403;
          if (refused && !span.value.attributes.has("auth.failure.reason"))
            span.value.attribute(
              "auth.failure.reason",
              response.status === 403 && span.value.attributes.has("executor.organization.id")
                ? "resource_denied"
                : "unclassified",
            );
          return response;
        }),
      );
    return yield* handler;
  });
