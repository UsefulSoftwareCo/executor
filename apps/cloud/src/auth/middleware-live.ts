// ---------------------------------------------------------------------------
// HTTP API middleware — live implementations (server-only).
// Imports the WorkOS SDK so it must NOT be pulled into the client bundle.
// ---------------------------------------------------------------------------

import { Effect, Layer, Redacted } from "effect";

import { AuthContext, NoOrganization, Unauthorized } from "@executor-js/api/server";

import { OrgAuth, SessionAuth, SessionContext, sessionFromSealed } from "./middleware";
import { WorkOSClient } from "./workos";

export const SessionAuthLive = Layer.effect(
  SessionAuth,
  Effect.gen(function* () {
    const workos = yield* WorkOSClient;
    return {
      cookie: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const result = yield* workos
            .authenticateSealedSession(Redacted.value(credential))
            .pipe(Effect.orElseSucceed(() => null));

          if (!result) {
            return yield* Effect.fail(new Unauthorized());
          }

          const session = sessionFromSealed(result, Redacted.value(credential));
          return yield* Effect.provideService(httpEffect, SessionContext, session);
        }),
    };
  }),
);

export const OrgAuthLive = Layer.effect(
  OrgAuth,
  Effect.gen(function* () {
    const workos = yield* WorkOSClient;
    return {
      cookie: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const result = yield* workos
            .authenticateSealedSession(Redacted.value(credential))
            .pipe(Effect.orElseSucceed(() => null));

          if (!result) {
            return yield* Effect.fail(new Unauthorized());
          }

          if (!result.organizationId) {
            return yield* Effect.fail(new NoOrganization());
          }

          const session = sessionFromSealed(result, Redacted.value(credential));
          const auth = {
            accountId: session.accountId,
            organizationId: result.organizationId,
            email: session.email,
            name: session.name,
            avatarUrl: session.avatarUrl,
            // The unified `AuthContext` carries roles; cloud's WorkOS control
            // plane does not resolve them here, so pass an empty list (no cloud
            // handler reads roles today).
            roles: [],
          };

          return yield* Effect.provideService(httpEffect, AuthContext, auth);
        }),
    };
  }),
);
