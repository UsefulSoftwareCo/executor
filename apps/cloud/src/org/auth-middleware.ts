import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AuthContext, requestScopedMiddleware } from "@executor-js/api/server";

import { UserStoreService } from "../auth/context";
import { sessionFromSealed } from "../auth/middleware";
import { ORG_SELECTOR_HEADER, authorizeOrganizationSelector } from "../auth/organization";
import { WorkOSClient } from "../auth/workos";
import { DbService } from "../db/db";

const unauthorized = () =>
  HttpServerResponse.jsonUnsafe(
    {
      error: "Invalid or expired session",
      code: "invalid_session",
    },
    { status: 401 },
  );

const noOrganization = () =>
  HttpServerResponse.jsonUnsafe(
    {
      error: "No organization in session",
      code: "no_organization",
    },
    { status: 403 },
  );

const OrgAuthMiddleware = HttpRouter.middleware<{ provides: AuthContext }>()(
  Effect.gen(function* () {
    const captured = yield* Effect.context<WorkOSClient>();
    const workos = yield* WorkOSClient;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const cookieValue = request.cookies["wos-session"] ?? "";
        const result = yield* workos
          .authenticateSealedSession(cookieValue)
          .pipe(Effect.orElseSucceed(() => null));
        if (!result) return unauthorized();

        const selector = request.headers[ORG_SELECTOR_HEADER] ?? result.organizationId;
        if (!selector) return noOrganization();

        const org = yield* authorizeOrganizationSelector(result.userId, selector).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (!org) return noOrganization();

        const session = sessionFromSealed(result, cookieValue);
        const auth = AuthContext.of({
          accountId: session.accountId,
          organizationId: org.id,
          email: session.email,
          name: session.name,
          avatarUrl: session.avatarUrl,
          roles: [],
        });

        return yield* Effect.provideService(httpEffect, AuthContext, auth);
      }).pipe(Effect.provideContext(captured));
  }),
);

export const orgAuthMiddleware = (rsLive: Layer.Layer<DbService | UserStoreService>) =>
  OrgAuthMiddleware.combine(requestScopedMiddleware(rsLive)).layer;
