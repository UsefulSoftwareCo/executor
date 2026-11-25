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

export const recordCaller = (organization: string, user: string) => {
  const attributes = callerSpanAttributes(organization, user);
  return Effect.andThen(Effect.annotateCurrentSpan(attributes), annotateRequestSpan(attributes));
};

export const recordCredential = (credential: {
  readonly kind: AuthCredentialKind;
  readonly id?: string | undefined;
  readonly user?: string | undefined;
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

export const recordSessionCredential = (principal: Principal) =>
  recordCredential({
    kind: "session",
    id: principal.sessionId,
    user: principal.userId,
    impersonatedBy: principal.impersonatedBy,
  });

export const recordAuthFailure = (reason: AuthFailureReason) =>
  annotateRequestSpan({ "auth.failure.reason": reason });

export const recordNoSession = (headers: Headers) =>
  presentsSessionCookie(headers)
    ? Effect.andThen(recordCredential({ kind: "session" }), recordAuthFailure("unknown"))
    : Effect.andThen(recordCredential({ kind: "none" }), recordAuthFailure("missing"));

const presentsSessionCookie = (headers: Headers) =>
  /(?:^|;)\s*[^=;\s]*\.session_token=/u.test(headers.get("cookie") ?? "");

export const recordNoCredential = (headers: Headers) =>
  headers.has("authorization") || presentsSessionCookie(headers)
    ? Effect.void
    : Effect.andThen(recordCredential({ kind: "none" }), recordAuthFailure("missing"));

export const refuse = <E>(reason: AuthFailureReason, error: E) =>
  Effect.andThen(recordAuthFailure(reason), Effect.fail(error));

export const refusedAs =
  (reason: AuthFailureReason) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.tapError(effect, (error) =>
      Schema.is(OrganizationForbidden)(error) ? recordAuthFailure(reason) : Effect.void,
    );

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
