// ---------------------------------------------------------------------------
// The per-request service layer, in its own module.
// ---------------------------------------------------------------------------
//
// Split out of `./layers` so a module can depend on the per-request postgres
// socket WITHOUT pulling in the protected (plugin) API that `./layers` also
// assembles — `makeProtectedApiLayer(cloudPlugins, …)` drags the whole plugin /
// OpenAPI / GraphQL / MCP / execution-substrate graph in with it. The auth
// plane (`../app-auth`) needs exactly this layer and none of that, so the
// definition lives here and `./layers` re-exports it for existing callers.
// ---------------------------------------------------------------------------

import { Layer } from "effect";

import type { MemberDirectory } from "@executor-js/api/server";

import { UserStoreService } from "../auth/context";
import { cloudMemberDirectoryLayer } from "../auth/member-directory";
import { WorkOsMirror } from "../auth/workos-mirror";
import { DbService } from "../db/db";

const DbLive = DbService.Live;
const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));
const WorkOsMirrorLive = WorkOsMirror.Live.pipe(Layer.provide(DbLive));
// The shared `MemberDirectory` read seam over the membership mirror — the
// same per-request socket the mirror writes through.
const MemberDirectoryLive = cloudMemberDirectoryLayer.pipe(Layer.provide(DbLive));

// Per-request layer. Anything that opens an I/O object (postgres.js socket,
// fetch stream readers, anything backed by a `Writable`) MUST live here —
// `provideRequestScoped` rebuilds it per request so Cloudflare Workers'
// I/O isolation is satisfied. See `api.request-scope.test.ts`.
export const RequestScopedServicesLive: Layer.Layer<
  DbService | UserStoreService | WorkOsMirror | MemberDirectory
> = Layer.mergeAll(DbLive, UserStoreLive, WorkOsMirrorLive, MemberDirectoryLive);
