import { Effect, Layer } from "effect";

import { IdentityProvider, type Principal, Unauthorized } from "@executor-js/api/server";

import { safeEqual } from "./serve-shared";

// ---------------------------------------------------------------------------
// The local identity seam — the production implementation of the shared
// `IdentityProvider` from `@executor-js/api/server` for the single-user local
// daemon.
//
// Local is single-user: there is no account/org directory, and the executor it
// serves is a single boot-built instance scoped to the working directory (see
// `FixedExecutionProvider` in `app.ts`). There is exactly ONE credential — the
// locally-minted bearer token (see `auth.ts`) — and exactly ONE Principal. So
// this provider validates the `Authorization: Bearer <token>` header against the
// boot token and resolves the one local Principal, or fails `Unauthorized`.
//
// This is the authoritative gate for the typed `/api` (the shared
// `ExecutionStackMiddleware` calls `authenticate(request)` with the Web
// `Request`). The Bun serve shell (`serve.ts`) additionally fast-path-rejects
// unauthenticated requests and is the gate for the non-typed local surfaces
// (`/mcp`, the MCP approval endpoint, the OAuth await poll) that never reach
// this middleware — both read the SAME boot token.
// ---------------------------------------------------------------------------

/**
 * The single local Principal every authenticated request resolves to. Stable
 * across the process; the `local` ids identify the single-user daemon in
 * `AuthContext` and any "me"-style surfaces. The fixed executor's scope is
 * cwd-derived (in `app.ts`), independent of these ids.
 */
export const LOCAL_PRINCIPAL: Principal = {
  accountId: "local",
  organizationId: "local",
  organizationName: "Local",
  email: "local@localhost",
  name: "Local",
  avatarUrl: null,
  roles: [],
};

const bearerToken = (headers: Headers): string | undefined => {
  const authorization = headers.get("authorization");
  if (!authorization) return undefined;
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim() || undefined
    : undefined;
};

// The OAuth provider callback is hit by the user's external browser, which
// can't carry our bearer — the OAuth `state` (validated downstream by
// completeOAuth) is the security gate. The Bun shell strips the `/api` prefix
// before this layer runs, so the path here is `/oauth/callback`. This mirrors
// the shell's `isUnauthenticatedOAuthCallbackPath` exemption (cloud/self-host
// instead authenticate the callback via the same-origin session cookie).
const isUnauthenticatedCallback = (request: Request): boolean => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: parsing a request URL that should always be valid here
  try {
    return /\/oauth\/callback(\/|$)/.test(new URL(request.url).pathname);
  } catch {
    return false;
  }
};

/**
 * Build the local `IdentityProvider`: validate the request's bearer token
 * against the boot token and resolve `LOCAL_PRINCIPAL`, else fail `Unauthorized`
 * (rendered as a 401 by the middleware's failure strategy). A complete
 * `Layer<IdentityProvider>` with no residual requirement, so the facade captures
 * it once at boot like self-host's.
 */
export const makeLocalIdentityLayer = (token: string): Layer.Layer<IdentityProvider> =>
  Layer.succeed(IdentityProvider)(
    IdentityProvider.of({
      authenticate: (request) => {
        if (isUnauthenticatedCallback(request)) return Effect.succeed(LOCAL_PRINCIPAL);
        const presented = bearerToken(request.headers);
        return presented !== undefined && safeEqual(presented, token)
          ? Effect.succeed(LOCAL_PRINCIPAL)
          : Effect.fail(new Unauthorized());
      },
    }),
  );
