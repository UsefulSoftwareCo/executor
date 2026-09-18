// ---------------------------------------------------------------------------
// The WorkOS session + org route Layers, and the `/api`-prefixed router view
// they register on.
// ---------------------------------------------------------------------------
//
// Split out of `./routes` so BOTH planes can mount the SAME Layer values:
//
//   - the full app plane (`../app` -> `ExecutorApp.make`'s `extensions.routes`)
//   - the auth plane (`../app-auth`), the small handler `server.ts` dispatches
//     session/auth traffic to without evaluating the plugin/OpenAPI/MCP graph.
//
// Sharing the constructors rather than re-deriving them is what makes the two
// planes byte-identical on these routes: same handlers, same middleware order,
// same prefixed router, same error rendering.
// ---------------------------------------------------------------------------

import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { requestScopedMiddleware, type MemberDirectory } from "@executor-js/api/server";

import { UserStoreService } from "../auth/context";
import { WorkOsMirror } from "../auth/workos-mirror";
import {
  CloudAuthPublicHandlers,
  CloudSessionAuthHandlers,
  NonProtectedApi,
} from "../auth/handlers";
import { SessionAuthLive } from "../auth/middleware-live";
import { OrgHttpApi } from "../org/api";
import { orgAuthMiddleware } from "../org/auth-middleware";
import { OrgHandlers } from "../org/handlers";
import { AutumnService } from "./billing/service";
import { DbService } from "../db/db";

/**
 * The `/api`-prefixed `HttpRouter` view every cloud HttpApi group registers on,
 * so `/auth/me` serves at `/api/auth/me` (matching the protected + account
 * plane). Derived from the ambient router, exactly as `ExecutorApp.make` builds
 * its own internal prefixed view for the protected API.
 */
export const apiPrefixedRouter = Layer.effect(HttpRouter.HttpRouter)(
  Effect.map(HttpRouter.HttpRouter.asEffect(), (router) => router.prefixed("/api")),
);

/** The per-request layer the session + org handlers read (the postgres socket). */
export type SessionRequestScoped = Layer.Layer<
  DbService | UserStoreService | WorkOsMirror | MemberDirectory
>;

/**
 * Session routes (login / callback / logout / me / organizations / …).
 * Handlers yield `UserStoreService` directly; the per-request DB combine keeps
 * the postgres socket request-scoped.
 *
 * `AutumnService.Default` is provided because the `createOrganization` free-limit
 * gate, `deleteOrganization`, and the seat report every sign-in fires read it —
 * the few app-only billing touchpoints. It is NOT on the neutral boot core.
 */
export const makeSessionRoutes = (rsLive: SessionRequestScoped) =>
  HttpApiBuilder.layer(NonProtectedApi).pipe(
    Layer.provide(Layer.mergeAll(CloudAuthPublicHandlers, CloudSessionAuthHandlers)),
    Layer.provide(requestScopedMiddleware(rsLive).layer),
    Layer.provideMerge(SessionAuthLive),
    Layer.provideMerge(AutumnService.Default),
    Layer.provide(apiPrefixedRouter),
  );

/**
 * Cloud-only WorkOS domain-verification routes; the auth middleware resolves
 * the URL org selector header before falling back to the session org, so slug
 * lookup needs the same request-scoped UserStoreService as other org-scoped
 * APIs. The verification-link handler gates on billing, hence `AutumnService`.
 */
export const makeOrgRoutes = (rsLive: SessionRequestScoped) =>
  HttpApiBuilder.layer(OrgHttpApi).pipe(
    Layer.provide(OrgHandlers),
    Layer.provide(orgAuthMiddleware(rsLive)),
    Layer.provideMerge(AutumnService.Default),
    Layer.provide(apiPrefixedRouter),
  );
