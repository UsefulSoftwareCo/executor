// ---------------------------------------------------------------------------
// Cloud admin users API — the shared, provider-neutral `AdminUsersHandlers`
// backed by a WorkOS-authorized platform view, mounted at `/api/admin/users*`.
//
// TWO credentials reach this plane, and they are the two an operator actually
// has:
//   1. an ORG-SCOPED api key -> `PlatformAuth`. The key IS the authority: WorkOS
//      validated it and reported which org owns it, and there is no member
//      behind it to check membership for. This is the machine credential
//      (a customer's backend calling us).
//   2. an admin SESSION member -> the console. Requires a live `getUserOrgMembership`
//      whose role slug is `admin` AND whose status is `active`, matching the
//      strictest existing cloud guard (`auth/handlers.ts`'s org-delete check) —
//      a pending admin invite is not an admin.
// A plain member session, or a USER-scoped api key, is refused: both name one
// acting member, and this plane deliberately serves the whole tenant.
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

import { ApiKeyService } from "../auth/api-keys";
import { UserStoreService } from "../auth/context";
import { isPlatformAuth, resolveBearerAuth } from "../auth/workos-auth-provider";
import { orgSelectorFromRequest, authorizeOrganizationSelector } from "../auth/organization";
import { WorkOSClient } from "../auth/workos";
import { DbService } from "../db/db";
import { CloudExecutionSeamsLayer } from "../engine/execution-stack";

/**
 * Resolve the tenant this request may read, or fail with the neutral 401/403.
 *
 * Returns only the organization id: nothing downstream needs to know WHICH of
 * the two credentials got the caller here, and keeping the acting member out of
 * the return value means no admin read can accidentally become subject-scoped.
 */
const authorizeTenant = (
  request: Request,
): Effect.Effect<
  string,
  AdminUsersUnauthorized | AdminUsersForbidden,
  WorkOSClient | ApiKeyService | UserStoreService
> =>
  Effect.gen(function* () {
    // (1) The bearer path. `resolveBearerAuth` (not `resolveApiKeyPrincipal`,
    // which rejects org keys for the product plane) is what distinguishes an
    // org key from a user key.
    const bearer = yield* resolveBearerAuth(request).pipe(
      // Every rejected-credential and infra failure collapses to one refusal:
      // this plane must not report whether a key exists, belongs to another
      // org, or merely lacks privilege.
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (bearer !== null) {
      if (isPlatformAuth(bearer)) return bearer.organizationId;
      // A user-scoped key authenticated fine but names one member; the platform
      // plane has no honest way to serve it.
      return yield* new AdminUsersForbidden();
    }

    // (2) The session path: a live admin membership in the selected org.
    const workos = yield* WorkOSClient;
    const session = yield* workos
      .authenticateRequest(request)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (!session) return yield* new AdminUsersUnauthorized();

    const selector = orgSelectorFromRequest(request) ?? session.organizationId;
    if (!selector) return yield* new AdminUsersForbidden();
    // Re-checks live membership, so the org selector header can only ever name
    // an org the caller already belongs to.
    const org = yield* authorizeOrganizationSelector(session.userId, selector).pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (!org) return yield* new AdminUsersForbidden();

    const membership = yield* workos
      .getUserOrgMembership(org.id, session.userId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    // A pending admin invite is not an active admin — require both.
    if (!membership || membership.status !== "active" || membership.role?.slug !== "admin") {
      return yield* new AdminUsersForbidden();
    }
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
  WorkOSClient | ApiKeyService | UserStoreService | DbProvider | PluginsProvider | HostConfig
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
  | ApiKeyService
  | UserStoreService
  | MemberDirectory
  | DbProvider
  | PluginsProvider
  | HostConfig
> = Layer.effect(AdminUsersProvider)(
  Effect.gen(function* () {
    const context = yield* Effect.context<
      WorkOSClient | ApiKeyService | UserStoreService | DbProvider | PluginsProvider | HostConfig
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
// `WorkOSClient | ApiKeyService` come from the surrounding boot context; the
// per-request `DbService`/`UserStoreService`/`MemberDirectory` (and the
// execution seams built over them) are supplied by the combined
// `requestScopedMiddleware`.
const AdminUsersProviderMiddleware = HttpRouter.middleware<{ provides: AdminUsersProvider }>()(
  Effect.gen(function* () {
    const longLived = yield* Effect.context<WorkOSClient | ApiKeyService>();
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
  rsLive: Layer.Layer<DbService | UserStoreService | MemberDirectory>,
  options: Parameters<typeof makeAdminUsersApiLayer>[1] = {},
) =>
  makeAdminUsersApiLayer(
    AdminUsersProviderMiddleware.combine(requestScopedMiddleware(rsLive)).layer,
    options,
  );
