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

import { env } from "cloudflare:workers";
import { HttpRouter } from "effect/unstable/http";
import { Context, Effect, Layer, Option } from "effect";

import {
  AdminUsersProvider,
  DbProvider,
  HostConfig,
  PluginsProvider,
  getAdminUser,
  listAdminAuditEvents,
  listAdminUserConnections,
  listAdminUsers,
  listAdminUsersWithConnections,
  makeAdminUsersApiLayer,
  makePlatformExecutor,
  normalizeAdminUserEmail,
  platformViewOf,
  requestScopedMiddleware,
  type AdminEmailResolver,
  type AdminIdentityDirectory,
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
 * How many user-detail reads run at once. Matches the account plane's own
 * member listing (`workos-account-service.ts`), which fans out the same way for
 * the same reason.
 */
const IDENTITY_CONCURRENCY = 5;

/**
 * Cloud's member directory: `externalId` → email/name.
 *
 * THE JOIN KEY is the membership's `userId` — the WorkOS `user_...` that
 * `workos-auth-provider.ts` binds as `accountId` on every credential path, and
 * therefore what the subject table records in `external_id`. The membership's
 * own `id` is an `om_...` row id and joins to nothing.
 *
 * WHY THIS IS TWO CALLS AND NOT ONE. The membership list is read once per
 * request and is the authority on who belongs to the org, but WorkOS's
 * `listOrganizationMemberships` carries no user detail and offers no
 * include/expand — email and name only exist on the user resource. The SDK does
 * expose a batched `listUsers({ organizationId })`, but the pinned
 * `@executor-js/emulate` WorkOS emulator serves only `GET
 * /user_management/users/:id`, so taking that path would leave every cloud e2e
 * user unnamed. So: ONE membership read per request, then user detail fetched
 * only for the ids ON THIS PAGE — never for the whole org, and never once per
 * row of some larger list. An id that is not an active/pending member is not
 * fetched at all and reports absent identity, which is the honest answer for a
 * member who left while their connections remain.
 */
const identityDirectory =
  (organizationId: string, context: Context.Context<WorkOSClient>): AdminIdentityDirectory =>
  (externalIds) =>
    Effect.gen(function* () {
      const workos = yield* WorkOSClient;
      const memberships = yield* workos.listOrgMembers(organizationId);
      const wanted = new Set(externalIds);
      const memberIds = memberships.data
        .map((membership) => membership.userId)
        .filter((userId) => wanted.has(userId));

      const resolved = yield* Effect.all(
        memberIds.map((userId) =>
          workos.getUser(userId).pipe(
            Effect.map(
              (user) =>
                [
                  userId,
                  {
                    email: user.email,
                    displayName: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
                  },
                ] as const,
            ),
            // One unreadable user must not cost the whole page its names.
            Effect.catchCause(() => Effect.succeed(null)),
          ),
        ),
        { concurrency: IDENTITY_CONCURRENCY },
      );

      const identities = new Map<string, AdminUserIdentity>();
      for (const entry of resolved) if (entry) identities.set(entry[0], entry[1]);
      return identities;
    }).pipe(Effect.provideContext(context));

/**
 * Cloud's REVERSE directory lookup: email → the WorkOS `user_...` id.
 *
 * Production asks WorkOS for the email AND organization in one request. Both
 * filters matter: email makes the lookup indexed rather than one `getUser`
 * request per member, while organization keeps the reverse lookup bound to the
 * same tenant as the platform view.
 *
 * The pinned `@executor-js/emulate` WorkOS emulator has no list-users route.
 * `WORKOS_API_URL` is the explicit test/dev emulator override, so that path
 * retains the membership scan until the emulator supports the production
 * query. The fallback still starts from the tenant's membership list and can
 * never return a user from another organization.
 *
 * CASING: WorkOS preserves whatever casing an email was created with (and the
 * emulator compares byte-exact), so the directory value is normalized here
 * before comparison, against an argument the seam already normalized.
 */
export const emailResolver =
  (organizationId: string, context: Context.Context<WorkOSClient>): AdminEmailResolver =>
  (email) =>
    Effect.gen(function* () {
      const workos = yield* WorkOSClient;

      if (!env.WORKOS_API_URL) {
        const users = yield* workos.listUsers({ email, organizationId });
        return users.data[0]?.id ?? null;
      }

      const memberships = yield* workos.listOrgMembers(organizationId);
      const userIds = memberships.data.map((membership) => membership.userId);

      // Emulator compatibility only. Short-circuit once the normalized email
      // matches so the fallback makes as few unsupported-detail reads as it can.
      const match = yield* Effect.findFirst(userIds, (userId) =>
        workos.getUser(userId).pipe(
          Effect.map((user) => normalizeAdminUserEmail(user.email ?? "") === email),
          // One unreadable user must not fail the whole lookup — it simply
          // cannot be the match.
          Effect.catchCause(() => Effect.succeed(false)),
        ),
      );
      return Option.getOrNull(match);
    }).pipe(Effect.provideContext(context));

/** Both directions of cloud's directory, built once per authorized request. */
const userDirectory = (
  organizationId: string,
  context: Context.Context<WorkOSClient>,
): AdminUserDirectory => ({
  identities: identityDirectory(organizationId, context),
  resolveEmail: emailResolver(organizationId, context),
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
    // The authorized tenant is handed to the body so an identity join reads the
    // SAME org the reads are scoped to — never one named by client input.
    return yield* Effect.ensuring(
      body(executor, organizationId),
      executor.close().pipe(Effect.ignore),
    );
  });

/**
 * Cloud's `AdminUsersProvider`, built per request so the platform executor
 * closes over the per-request postgres socket.
 */
export const workosAdminUsersProvider: Layer.Layer<
  AdminUsersProvider,
  never,
  WorkOSClient | ApiKeyService | UserStoreService | DbProvider | PluginsProvider | HostConfig
> = Layer.effect(AdminUsersProvider)(
  Effect.gen(function* () {
    const context = yield* Effect.context<
      WorkOSClient | ApiKeyService | UserStoreService | DbProvider | PluginsProvider | HostConfig
    >();
    return AdminUsersProvider.of({
      listAuditEvents: (headers, options) =>
        withPlatformView(headers, (executor, organizationId) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) =>
              listAdminAuditEvents(admin, options, userDirectory(organizationId, context)),
            ),
          ),
        ).pipe(Effect.provideContext(context)),
      listUsers: (headers, options) =>
        withPlatformView(headers, (executor, organizationId) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) =>
              listAdminUsers(admin, options, userDirectory(organizationId, context)),
            ),
          ),
        ).pipe(Effect.provideContext(context)),
      listUsersWithConnections: (headers, options) =>
        withPlatformView(headers, (executor, organizationId) =>
          platformViewOf(executor).pipe(
            Effect.flatMap((admin) =>
              listAdminUsersWithConnections(admin, options, userDirectory(organizationId, context)),
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
              getAdminUser(admin, identifier, userDirectory(organizationId, context)),
            ),
          ),
        ).pipe(Effect.provideContext(context)),
    });
  }),
);

// Builds the provider per request, providing it to the handlers. Long-lived
// `WorkOSClient | ApiKeyService` come from the surrounding boot context; the
// per-request `DbService`/`UserStoreService` (and the execution seams built
// over them) are supplied by the combined `requestScopedMiddleware`.
const AdminUsersProviderMiddleware = HttpRouter.middleware<{ provides: AdminUsersProvider }>()(
  Effect.gen(function* () {
    const longLived = yield* Effect.context<WorkOSClient | ApiKeyService>();
    return (httpEffect) =>
      Effect.gen(function* () {
        // Built inside the request body so the execution seams close over the
        // per-request postgres socket.
        const provider = yield* Effect.provide(
          AdminUsersProvider.asEffect(),
          workosAdminUsersProvider.pipe(Layer.provide(CloudExecutionSeamsLayer)),
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
  rsLive: Layer.Layer<DbService | UserStoreService>,
  options: Parameters<typeof makeAdminUsersApiLayer>[1] = {},
) =>
  makeAdminUsersApiLayer(
    AdminUsersProviderMiddleware.combine(requestScopedMiddleware(rsLive)).layer,
    options,
  );
