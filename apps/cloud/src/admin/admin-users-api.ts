// ---------------------------------------------------------------------------
// Cloud admin users API — the shared, provider-neutral `AdminUsersHandlers`
// backed by a WorkOS-authorized platform view, mounted at `/api/admin/users*`.
//
// Only an active admin browser session with a completed second factor reaches
// this plane. Bearer credentials retain ordinary product access, never cross-user
// access, even when accompanied by a verified browser cookie.
//
// The executor is built by `makePlatformExecutor` — `{ tenant, subject:
// undefined, platformView: true }` — so the reads are tenant-wide and read-only
// by storage policy, and no `subject` row is minted for the caller.
//
// Cross-tenant isolation is structural, not a check in this file: the tenant is
// taken from the resolved credential (the key's own org, or the session's
// authorized org), never from client input, and `reach: "tenant"` still filters
// every query by that tenant.
// ---------------------------------------------------------------------------

import { HttpRouter } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import {
  AdminUsersProvider,
  DbProvider,
  HostConfig,
  MemberDirectory,
  PluginsProvider,
  adminUserDirectoryFromMembers,
  getAdminUser,
  listAdminUserConnections,
  listAdminUsers,
  listAdminUsersWithConnections,
  makeAdminUsersApiLayer,
  makePlatformExecutor,
  platformViewOf,
  requestScopedMiddleware,
  type AdminUsersHeaders,
} from "@executor-js/api/server";
import {
  AdminUserNotFound,
  AdminUsersError,
  AdminUsersForbidden,
  AdminUsersUnauthorized,
} from "@executor-js/api";
import type { Executor } from "@executor-js/sdk";

import { UserStoreService } from "../auth/context";
import { WorkOsMirror } from "../auth/workos-mirror";
import { orgSelectorFromRequest, authorizeOrganizationSelector } from "../auth/organization";
import { WorkOSClient } from "../auth/workos";
import { DbService } from "../db/db";
import { CloudExecutionSeamsLayer } from "../engine/execution-stack";

/**
 * Resolve the tenant this request may read, or fail with the neutral 401/403.
 *
 * Returns only the authorized organization id so admin reads remain tenant-scoped.
 * Exported for its test only.
 */
export const authorizeTenant = (
  request: Request,
): Effect.Effect<
  string,
  AdminUsersUnauthorized | AdminUsersForbidden,
  WorkOSClient | UserStoreService | MemberDirectory | WorkOsMirror
> =>
  Effect.gen(function* () {
    if (request.headers.has("authorization")) return yield* new AdminUsersForbidden();

    const workos = yield* WorkOSClient;
    const session = yield* workos
      .authenticateRequest(request)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (!session) return yield* new AdminUsersUnauthorized();

    const selector = orgSelectorFromRequest(request) ?? session.organizationId;
    if (!selector) return yield* new AdminUsersForbidden();
    // Re-checks membership against the mirror, so the org selector header can
    // only ever name an org the caller already belongs to. That read requires
    // an ACTIVE membership and reports its role as `memberRole`, so a pending
    // admin invite never resolves and the admin gate is that one value — not
    // a second read of the same row.
    const org = yield* authorizeOrganizationSelector(session.userId, selector).pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (!org) return yield* new AdminUsersForbidden();
    if (org.memberRole !== "admin") return yield* new AdminUsersForbidden();
    if (session.adminVerified !== true) return yield* new AdminUsersForbidden();
    return org.id;
  });

/**
 * Authorize, then run `body` against the tenant's platform view.
 *
 * The executor is built per request and closed after, like every other cloud
 * execution stack: it holds the per-request postgres socket, which Cloudflare's
 * I/O isolation forbids sharing across requests.
 */
const withPlatformView = <A, E extends AdminUsersError | AdminUserNotFound = AdminUsersError>(
  headers: AdminUsersHeaders,
  body: (executor: Executor, organizationId: string) => Effect.Effect<A, E>,
): Effect.Effect<
  A,
  // `AdminUsersError` unconditionally: opening the platform view can fail that
  // way regardless of what `body` itself raises.
  E | AdminUsersError | AdminUsersUnauthorized | AdminUsersForbidden,
  | WorkOSClient
  | UserStoreService
  | MemberDirectory
  | WorkOsMirror
  | DbProvider
  | PluginsProvider
  | HostConfig
> =>
  Effect.gen(function* () {
    const organizationId = yield* authorizeTenant(
      new Request("https://admin.invalid", { headers }),
    );
    const executor = yield* makePlatformExecutor(organizationId).pipe(
      Effect.mapError(() => new AdminUsersError({ message: "Failed to open the platform view" })),
    );
    // The authorized tenant is handed to the body so the directory reads the
    // SAME org the storage reads are scoped to — never one named by client
    // input.
    return yield* Effect.ensuring(
      body(executor, organizationId),
      executor.close().pipe(Effect.ignore),
    );
  });

/**
 * Cloud's `AdminUsersProvider`, built per request so the platform executor
 * closes over the per-request postgres socket.
 *
 * Identity (email/name per row), the `?email=` resolver and the `?search=`
 * match all come from the shared `MemberDirectory` — cloud's is the LOCAL
 * membership mirror (`auth/member-directory.ts`), so an admin page costs one
 * indexed query per direction and never a WorkOS read per member. The
 * directory is per-request too (it reads the same postgres socket), which is
 * why it is captured from the request context rather than at boot.
 */
export const workosAdminUsersProvider: Layer.Layer<
  AdminUsersProvider,
  never,
  | WorkOSClient
  | UserStoreService
  | MemberDirectory
  | WorkOsMirror
  | DbProvider
  | PluginsProvider
  | HostConfig
> = Layer.effect(AdminUsersProvider)(
  Effect.gen(function* () {
    const context = yield* Effect.context<
      | WorkOSClient
      | UserStoreService
      | MemberDirectory
      | WorkOsMirror
      | DbProvider
      | PluginsProvider
      | HostConfig
    >();
    const directory = yield* MemberDirectory;
    // The authorized tenant is what scopes the directory, so every read below
    // asks the same org the platform view was opened for.
    const userDirectory = (organizationId: string) =>
      adminUserDirectoryFromMembers(directory, organizationId);
    return AdminUsersProvider.of({
      listUsers: (headers, options) =>
        withPlatformView(headers, (executor, organizationId) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) =>
              listAdminUsers(admin, options, userDirectory(organizationId)),
            ),
          ),
        ).pipe(Effect.provideContext(context)),
      listUsersWithConnections: (headers, options) =>
        withPlatformView(headers, (executor, organizationId) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) =>
              listAdminUsersWithConnections(admin, options, userDirectory(organizationId)),
            ),
          ),
        ).pipe(Effect.provideContext(context)),
      listUserConnections: (headers, externalId) =>
        withPlatformView(headers, (executor) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) => listAdminUserConnections(admin, externalId)),
          ),
        ).pipe(Effect.provideContext(context)),
      getUser: (headers, identifier) =>
        withPlatformView(headers, (executor, organizationId) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) =>
              getAdminUser(admin, identifier, userDirectory(organizationId)),
            ),
          ),
        ).pipe(Effect.provideContext(context)),
    });
  }),
);

// Builds the provider per request, providing it to the handlers. Long-lived
// `WorkOSClient` come from the surrounding boot context; the
// per-request `DbService`/`UserStoreService`/`MemberDirectory` (and the
// execution seams built over them) are supplied by the combined
// `requestScopedMiddleware`.
const AdminUsersProviderMiddleware = HttpRouter.middleware<{
  provides: AdminUsersProvider;
}>()(
  Effect.gen(function* () {
    const longLived = yield* Effect.context<WorkOSClient>();
    return (httpEffect) =>
      Effect.gen(function* () {
        // Built inside the request body so the execution seams close over the
        // per-request postgres socket. `local` keeps that promise: the
        // `longLived` context re-applied below carries the boot `CurrentMemoMap`,
        // so a shared build would hand overlapping requests one another's socket.
        const provider = yield* Effect.provide(
          AdminUsersProvider.asEffect(),
          workosAdminUsersProvider.pipe(Layer.provide(CloudExecutionSeamsLayer)),
          { local: true },
        );
        return yield* Effect.provideService(httpEffect, AdminUsersProvider, provider);
      }).pipe(Effect.provideContext(longLived));
  }),
);

/**
 * The cloud admin-users route layer, mounted as an app extension under the same
 * `/api` prefix as the rest of the cloud router.
 */
export const makeCloudAdminUsersRoutes = (
  rsLive: Layer.Layer<DbService | UserStoreService | MemberDirectory | WorkOsMirror>,
  options: Parameters<typeof makeAdminUsersApiLayer>[1] = {},
) =>
  makeAdminUsersApiLayer(
    AdminUsersProviderMiddleware.combine(requestScopedMiddleware(rsLive)).layer,
    options,
  );
