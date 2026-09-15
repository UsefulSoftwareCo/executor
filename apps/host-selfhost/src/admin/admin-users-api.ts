// ---------------------------------------------------------------------------
// Self-host admin users API — the shared, provider-neutral `AdminUsersHandlers`
// backed by a Better-Auth-authorized platform view, mounted at
// `/api/admin/users*` beside the existing invite-code admin routes.
//
// AUTH: an owner/admin member of the single org, resolved by the shared
// `requireInstanceAdmin` — the SAME gate the invite-code admin API uses
// (`admin/handlers.ts`), not a new permission concept. Membership is resolved
// against the INSTANCE's organization id, never the caller's
// `session.activeOrganizationId`: see require-admin.ts for the privilege
// escalation that distinction refuses. Self-host has no
// organization-OWNED api key (Better Auth keys always belong to the user who
// created one), so there is no machine-credential path here; the operator's own
// admin session is the credential. That asymmetry with cloud is deliberate and
// is why `AdminUsersProvider` is a seam rather than one shared implementation.
//
// The READ half is identical to cloud's: a subject-less, tenant-reach executor
// from `makePlatformExecutor`, projected by the shared `admin/reads`. Self-host
// is single-tenant, so the tenant is always the boot-seeded org. Identity
// (email/name per row), the `?email=` resolver and the `?search=` match all
// come from the shared `MemberDirectory` — here Better Auth's `member` + `user`
// tables through its own adapter (`auth/member-directory.ts`), the SAME read
// the MCP plane makes, so no plane keeps its own join.
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

import { BetterAuth, type BetterAuthHandle } from "../auth/better-auth";
import { requireInstanceAdmin } from "./require-admin";
import { SelfHostDb, SelfHostDbProvider, type SelfHostDbHandle } from "../db/self-host-db";
import { SelfHostHostConfig, SelfHostPluginsProvider } from "../execution";

/**
 * The SAME gate the invite-code admin API applies — literally the same
 * function, not a second copy of the same idea, which is how the two planes
 * came to share a bypass. A plain member session is refused, and so is an owner
 * of some OTHER organization: this plane reports every user in the instance, so
 * the org it authorizes against is the instance's own (see require-admin.ts).
 */
const requireAdmin = (headers: AdminUsersHeaders) =>
  requireInstanceAdmin(new Headers(headers)).pipe(
    Effect.mapError((denial) =>
      denial === "unauthorized" ? new AdminUsersUnauthorized() : new AdminUsersForbidden(),
    ),
  );

const withPlatformView = <A, E extends AdminUsersError | AdminUserNotFound = AdminUsersError>(
  headers: AdminUsersHeaders,
  organizationId: string,
  body: (executor: Executor) => Effect.Effect<A, E>,
): Effect.Effect<
  A,
  // `AdminUsersError` unconditionally: opening the platform view can fail that
  // way regardless of what `body` itself raises.
  E | AdminUsersError | AdminUsersUnauthorized | AdminUsersForbidden,
  BetterAuth | DbProvider | PluginsProvider | HostConfig
> =>
  Effect.gen(function* () {
    yield* requireAdmin(headers);
    const executor = yield* makePlatformExecutor(organizationId).pipe(
      Effect.mapError(() => new AdminUsersError({ message: "Failed to open the platform view" })),
    );
    return yield* Effect.ensuring(body(executor), executor.close().pipe(Effect.ignore));
  });

export const betterAuthAdminUsersProvider: Layer.Layer<
  AdminUsersProvider,
  never,
  BetterAuth | MemberDirectory | DbProvider | PluginsProvider | HostConfig
> = Layer.effect(AdminUsersProvider)(
  Effect.gen(function* () {
    const context = yield* Effect.context<BetterAuth | DbProvider | PluginsProvider | HostConfig>();
    const { organizationId } = yield* BetterAuth;
    // Scoped to the INSTANCE's org — the same one the platform view is opened
    // for, never the caller's `activeOrganizationId` (see require-admin.ts).
    const directory = adminUserDirectoryFromMembers(yield* MemberDirectory, organizationId);
    return AdminUsersProvider.of({
      listUsers: (headers, options) =>
        withPlatformView(headers, organizationId, (executor) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) => listAdminUsers(admin, options, directory)),
          ),
        ).pipe(Effect.provideContext(context)),
      listUsersWithConnections: (headers, options) =>
        withPlatformView(headers, organizationId, (executor) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) => listAdminUsersWithConnections(admin, options, directory)),
          ),
        ).pipe(Effect.provideContext(context)),
      listUserConnections: (headers, externalId) =>
        withPlatformView(headers, organizationId, (executor) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) => listAdminUserConnections(admin, externalId)),
          ),
        ).pipe(Effect.provideContext(context)),
      getUser: (headers, identifier) =>
        withPlatformView(headers, organizationId, (executor) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) => getAdminUser(admin, identifier, directory)),
          ),
        ).pipe(Effect.provideContext(context)),
    });
  }),
);

export interface SelfHostAdminUsersApiDeps {
  readonly betterAuth: BetterAuthHandle;
  /** The boot-built `MemberDirectory` (see `resolveAuthProviders`), so this
   *  plane reads the same directory instance every other plane does. */
  readonly memberDirectory: Layer.Layer<MemberDirectory>;
  readonly db: SelfHostDbHandle;
  readonly mountPrefix: `/${string}`;
}

/**
 * The mountable extension route layer for `/api/admin/users*`. Self-host's DB
 * handle and Better Auth are app singletons, so the provider is self-contained
 * (no per-request socket to close over, unlike cloud) — but it still goes
 * through `requestScopedMiddleware`, because an HttpApi handler's service
 * requirement is not erased by a plain `Layer.provide` on the builder layer.
 */
export const makeSelfHostAdminUsersApiLayer = ({
  betterAuth,
  memberDirectory,
  db,
  mountPrefix,
}: SelfHostAdminUsersApiDeps) => {
  const prefixedRouter = Layer.effect(HttpRouter.HttpRouter)(
    Effect.map(HttpRouter.HttpRouter.asEffect(), (router) => router.prefixed(mountPrefix)),
  );
  const provider = betterAuthAdminUsersProvider.pipe(
    Layer.provide(Layer.succeed(BetterAuth)(betterAuth)),
    Layer.provide(memberDirectory),
    Layer.provide(SelfHostDbProvider),
    Layer.provide(SelfHostPluginsProvider),
    Layer.provide(SelfHostHostConfig),
    Layer.provide(Layer.succeed(SelfHostDb)(db)),
  );
  return makeAdminUsersApiLayer(requestScopedMiddleware(provider).layer, {
    router: prefixedRouter,
  });
};
