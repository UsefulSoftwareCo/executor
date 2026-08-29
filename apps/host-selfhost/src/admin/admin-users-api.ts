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
// is single-tenant, so the tenant is always the boot-seeded org.
// ---------------------------------------------------------------------------

import { HttpRouter } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import {
  AdminUsersProvider,
  DbProvider,
  HostConfig,
  PluginsProvider,
  getAdminUser,
  listAdminUserConnections,
  listAdminUsers,
  listAdminUsersWithConnections,
  BetterAuth,
  makeAdminUsersApiLayer,
  makePlatformExecutor,
  normalizeAdminUserEmail,
  platformViewOf,
  requestScopedMiddleware,
  type AdminUserDirectory,
  type AdminUserIdentity,
  type AdminUsersHeaders,
} from "@executor-js/api/server";
import {
  AdminUserNotFound,
  AdminUsersError,
  AdminUsersForbidden,
  AdminUsersUnauthorized,
} from "@executor-js/api";
import type { Executor } from "@executor-js/sdk";

import { type BetterAuthHandle } from "../auth/better-auth";
import { requireInstanceAdmin } from "@executor-js/api/server";
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

/**
 * Self-host's member directory: `externalId` → email/name.
 *
 * THE JOIN KEY is `member.userId`, the Better Auth `user.id` — precisely what
 * `auth/identity.ts` binds as `accountId` and therefore what the subject table
 * records in `external_id`. `member.id` is the organization `member` ROW id and
 * joins to nothing; the two look alike, so the choice is pinned here and in the
 * node test rather than left to a reader.
 *
 * One `listMembers` call per request: Better Auth's organization plugin already
 * attaches the `user` row to each member, so email and name arrive with the
 * membership and no per-user lookup is needed. The requested ids are not passed
 * to the call — the plugin offers no id filter, and a single-instance member
 * list is small — but the caller only reads the ids it asked for.
 *
 * Runs as the CALLER, using their own admin headers, so this reads exactly the
 * directory that session is already entitled to on `/account/members`.
 */
const listMembers = (auth: BetterAuthHandle["auth"], headers: AdminUsersHeaders) =>
  Effect.tryPromise(() => auth.api.listMembers({ headers: new Headers(headers) }));

/**
 * Both directions of self-host's directory, over the SAME single `listMembers`
 * read.
 *
 * The reverse (email → `user.id`) needs no extra call and no new permission:
 * the organization plugin already attaches the `user` row to each member, so
 * the email is sitting beside the id the forward join uses. Better Auth
 * lower-cases every email it writes, but the directory value is normalized
 * anyway so this host cannot answer differently from cloud if that ever
 * changes.
 *
 * A member with no `user.email` cannot match — `null` is not an address, and
 * coercing it to "" would let an empty `?email=` select an arbitrary row.
 */
const userDirectory = (
  auth: BetterAuthHandle["auth"],
  headers: AdminUsersHeaders,
): AdminUserDirectory => ({
  identities: () =>
    listMembers(auth, headers).pipe(
      Effect.map((result) => {
        const identities = new Map<string, AdminUserIdentity>();
        for (const member of result.members) {
          identities.set(member.userId, {
            email: member.user?.email ?? null,
            displayName: member.user?.name ?? null,
          });
        }
        return identities;
      }),
    ),
  resolveEmail: (email) =>
    listMembers(auth, headers).pipe(
      Effect.map(
        (result) =>
          result.members.find((member) => {
            const stored = member.user?.email;
            return stored != null && normalizeAdminUserEmail(stored) === email;
          })?.userId ?? null,
      ),
    ),
});

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
  BetterAuth | DbProvider | PluginsProvider | HostConfig
> = Layer.effect(AdminUsersProvider)(
  Effect.gen(function* () {
    const context = yield* Effect.context<BetterAuth | DbProvider | PluginsProvider | HostConfig>();
    const { auth, organizationId } = yield* BetterAuth;
    return AdminUsersProvider.of({
      listUsers: (headers, options) =>
        withPlatformView(headers, organizationId, (executor) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) => listAdminUsers(admin, options, userDirectory(auth, headers))),
          ),
        ).pipe(Effect.provideContext(context)),
      listUsersWithConnections: (headers, options) =>
        withPlatformView(headers, organizationId, (executor) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) =>
              listAdminUsersWithConnections(admin, options, userDirectory(auth, headers)),
            ),
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
            Effect.flatMap((admin) =>
              getAdminUser(admin, identifier, userDirectory(auth, headers)),
            ),
          ),
        ).pipe(Effect.provideContext(context)),
    });
  }),
);

export interface SelfHostAdminUsersApiDeps {
  readonly betterAuth: BetterAuthHandle;
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
  db,
  mountPrefix,
}: SelfHostAdminUsersApiDeps) => {
  const prefixedRouter = Layer.effect(HttpRouter.HttpRouter)(
    Effect.map(HttpRouter.HttpRouter.asEffect(), (router) => router.prefixed(mountPrefix)),
  );
  const provider = betterAuthAdminUsersProvider.pipe(
    Layer.provide(Layer.succeed(BetterAuth)(betterAuth)),
    Layer.provide(SelfHostDbProvider),
    Layer.provide(SelfHostPluginsProvider),
    Layer.provide(SelfHostHostConfig),
    Layer.provide(Layer.succeed(SelfHostDb)(db)),
  );
  return makeAdminUsersApiLayer(requestScopedMiddleware(provider).layer, {
    router: prefixedRouter,
  });
};
