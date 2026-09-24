// ---------------------------------------------------------------------------
// HTTP API middleware — live implementations (server-only).
// Imports the WorkOS SDK so it must NOT be pulled into the client bundle.
// ---------------------------------------------------------------------------

import { Effect, Layer, Redacted } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import { AuthContext, NoOrganization, Unauthorized } from "@executor-js/api/server";

import {
  OrgAuth,
  SessionAuth,
  SessionContext,
  SessionCookies,
  sessionFromSealed,
  type SessionCookieOptions,
  type SessionCookieSetter,
} from "./middleware";
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

          // Per-request cookie queue. Typed `.handle()` session handlers (the
          // WorkOS session-refresh on switchOrganization / createOrganization /
          // acceptInvitation) return DATA, so they can't attach a Set-Cookie
          // themselves — they `yield* SessionCookies` and queue writes, which we
          // drain onto the response below. This is what lets `handlers.ts` drop
          // the `@tanstack/react-start/server` `setCookie` import (the sole thing
          // that pulled TanStack Start into the backend / Durable-Object graph).
          const pending: Array<{
            readonly name: string;
            readonly value: string;
            readonly options: SessionCookieOptions;
          }> = [];
          const cookieSetter: SessionCookieSetter = {
            set: (name, value, options) => {
              pending.push({ name, value, options });
            },
          };

          const session = sessionFromSealed(result, Redacted.value(credential));
          const response = yield* httpEffect.pipe(
            Effect.provideService(SessionContext, session),
            Effect.provideService(SessionCookies, cookieSetter),
          );
          return pending.reduce(
            (res, c) => HttpServerResponse.setCookieUnsafe(res, c.name, c.value, c.options),
            response,
          );
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
