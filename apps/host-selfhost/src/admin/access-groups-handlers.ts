import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import { makeScopedExecutor } from "@executor-js/api/server";
import {
  ConnectionName,
  IntegrationSlug,
  type ConnectionNotFoundError,
  type Executor,
  type StorageFailure,
} from "@executor-js/sdk";

import { BetterAuth, type BetterAuthHandle } from "../auth/better-auth";
import { requireInstanceAdmin } from "./require-admin";
import { SelfHostDb, SelfHostDbProvider, type SelfHostDbHandle } from "../db/self-host-db";
import { SelfHostHostConfig, SelfHostPluginsProvider } from "../execution";
import type { SelfHostPlugins } from "../plugins";
import {
  AccessGroupsError,
  AccessGroupsForbidden,
  AccessGroupsHttpApi,
  AccessGroupsNotFound,
  AccessGroupsUnauthorized,
} from "./access-groups-api";

// ---------------------------------------------------------------------------
// Handlers for the self-host access-groups API. Every route is gated by the
// SHARED `requireInstanceAdmin` (the same gate as the invite plane, resolved
// against the INSTANCE's own organization — see require-admin.ts), then runs
// against a scoped executor bound to the ADMIN caller: writable, unlike the
// admin-users platform view, because this plane edits group rows. The
// engine's `accessGroups` closures read the tenant-scoped tables tenant-wide,
// so an admin manages groups they are not a member of; their RUNTIME sessions
// stay filtered like everyone's.
// ---------------------------------------------------------------------------

const requestHeaders = Effect.map(
  HttpServerRequest.HttpServerRequest.asEffect(),
  (request): Headers => new Headers({ ...request.headers }),
);

const requireAdmin = (headers: Headers) =>
  requireInstanceAdmin(headers).pipe(
    Effect.mapError((denial) =>
      denial === "unauthorized" ? new AccessGroupsUnauthorized() : new AccessGroupsForbidden(),
    ),
  );

/** Render engine failures in this plane's vocabulary: a missing connection is
 *  404, everything else (rule violations, storage) carries its message. */
const renderEngineErrors = <A, R>(
  effect: Effect.Effect<A, ConnectionNotFoundError | StorageFailure, R>,
): Effect.Effect<A, AccessGroupsNotFound | AccessGroupsError, R> =>
  effect.pipe(
    Effect.catchTag("ConnectionNotFoundError", () => Effect.fail(new AccessGroupsNotFound())),
    Effect.catchTag("StorageError", (error) =>
      Effect.fail(new AccessGroupsError({ message: error.message })),
    ),
    Effect.catchTag("UniqueViolationError", () =>
      Effect.fail(new AccessGroupsError({ message: "Storage conflict" })),
    ),
  );

/** Render toolkit-extension failures: the extension's rule violations
 *  (unknown toolkit, non-org toolkit) all surface as `ToolkitError` with an
 *  actionable message — this is an admin plane, so the message rides through
 *  as a 400. */
const renderToolkitErrors = <A, R>(
  effect: Effect.Effect<
    A,
    { readonly _tag: "ToolkitError"; readonly message: string } | StorageFailure,
    R
  >,
): Effect.Effect<A, AccessGroupsError, R> =>
  effect.pipe(
    Effect.catchTag("ToolkitError", (error) =>
      Effect.fail(new AccessGroupsError({ message: error.message })),
    ),
    Effect.catchTag("StorageError", (error) =>
      Effect.fail(new AccessGroupsError({ message: error.message })),
    ),
    Effect.catchTag("UniqueViolationError", () =>
      Effect.fail(new AccessGroupsError({ message: "Storage conflict" })),
    ),
  );

/** Authorize, then run `body` against a writable executor bound to the admin
 *  caller; the executor is always closed. Typed with the host plugin tuple so
 *  the toolkits extension is reachable. */
const withAdminExecutor = <A, E>(
  body: (executor: Executor<SelfHostPlugins>) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const member = yield* requireAdmin(yield* requestHeaders);
    const { organizationId } = yield* BetterAuth;
    const executor = yield* makeScopedExecutor<SelfHostPlugins>(
      member.userId,
      organizationId,
      "",
    ).pipe(
      Effect.mapError(() => new AccessGroupsError({ message: "Failed to open the executor" })),
    );
    return yield* Effect.ensuring(body(executor), executor.close().pipe(Effect.ignore));
  });

/** The toolkit grant names a group that must exist — this plane owns that
 *  referential check (the toolkits plugin cannot read the group tables). */
const requireGroupExists = (executor: Executor<SelfHostPlugins>, group: string) =>
  executor.accessGroups.list().pipe(
    Effect.catchTag("StorageError", (error) =>
      Effect.fail(new AccessGroupsError({ message: error.message })),
    ),
    Effect.catchTag("UniqueViolationError", () =>
      Effect.fail(new AccessGroupsError({ message: "Storage conflict" })),
    ),
    Effect.flatMap((groups) =>
      groups.some((candidate) => String(candidate.id) === group)
        ? Effect.void
        : Effect.fail(new AccessGroupsError({ message: `Access group not found: ${group}` })),
    ),
  );

const groupToWire = (group: {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}) => ({
  id: group.id,
  name: group.name,
  createdAt: group.createdAt.toISOString(),
  updatedAt: group.updatedAt.toISOString(),
});

const memberToWire = (member: {
  readonly groupId: string;
  readonly subject: string;
  readonly createdAt: Date;
}) => ({
  groupId: member.groupId,
  subject: member.subject,
  createdAt: member.createdAt.toISOString(),
});

export const AccessGroupsHandlers = HttpApiBuilder.group(
  AccessGroupsHttpApi,
  "accessGroups",
  (handlers) =>
    handlers
      .handle("listGroups", () =>
        withAdminExecutor((executor) =>
          renderEngineErrors(
            executor.accessGroups
              .list()
              .pipe(Effect.map((groups) => ({ groups: groups.map(groupToWire) }))),
          ),
        ),
      )
      .handle("createGroup", ({ payload }) =>
        withAdminExecutor((executor) =>
          renderEngineErrors(
            executor.accessGroups.create({ name: payload.name }).pipe(Effect.map(groupToWire)),
          ),
        ),
      )
      .handle("renameGroup", ({ params, payload }) =>
        withAdminExecutor((executor) =>
          renderEngineErrors(
            executor.accessGroups
              .update({ id: params.groupId, name: payload.name })
              .pipe(Effect.map(groupToWire)),
          ),
        ),
      )
      .handle("deleteGroup", ({ params }) =>
        withAdminExecutor((executor) =>
          // The engine refuses deletion while a CONNECTION references the
          // group; toolkit grants live in plugin storage the engine cannot
          // see, so this plane holds the same no-dangling-reference line for
          // them (a dangling grant would hide the toolkit from everyone).
          renderToolkitErrors(executor.toolkits.listRestrictedToolkits()).pipe(
            Effect.flatMap((grants) => {
              const grant = grants.find((candidate) => candidate.group === params.groupId);
              return grant
                ? Effect.fail(
                    new AccessGroupsError({
                      message: `Access group ${params.groupId} still restricts toolkit ${grant.slug}; remove that grant before deleting the group.`,
                    }),
                  )
                : renderEngineErrors(
                    executor.accessGroups
                      .remove({ id: params.groupId })
                      .pipe(Effect.map(() => ({ success: true }))),
                  );
            }),
          ),
        ),
      )
      .handle("listMembers", ({ params }) =>
        withAdminExecutor((executor) =>
          renderEngineErrors(
            executor.accessGroups
              .members(params.groupId)
              .pipe(Effect.map((members) => ({ members: members.map(memberToWire) }))),
          ),
        ),
      )
      .handle("addMember", ({ params, payload }) =>
        withAdminExecutor((executor) =>
          renderEngineErrors(
            executor.accessGroups
              .addMember({ id: params.groupId, subject: payload.subject })
              .pipe(Effect.map(memberToWire)),
          ),
        ),
      )
      .handle("removeMember", ({ params }) =>
        withAdminExecutor((executor) =>
          renderEngineErrors(
            executor.accessGroups
              .removeMember({ id: params.groupId, subject: params.subject })
              .pipe(Effect.map(() => ({ success: true }))),
          ),
        ),
      )
      .handle("listRestrictions", () =>
        withAdminExecutor((executor) =>
          renderEngineErrors(
            executor.accessGroups.restrictions().pipe(
              Effect.map((restrictions) => ({
                restrictions: restrictions.map((restriction) => ({
                  integration: String(restriction.integration),
                  name: String(restriction.name),
                  group: String(restriction.group),
                })),
              })),
            ),
          ),
        ),
      )
      .handle("restrictConnection", ({ payload }) =>
        withAdminExecutor((executor) =>
          renderEngineErrors(
            executor.accessGroups
              .restrictConnection({
                integration: IntegrationSlug.make(payload.integration),
                name: ConnectionName.make(payload.name),
                group: payload.group,
              })
              .pipe(Effect.map(() => ({ success: true }))),
          ),
        ),
      )
      .handle("unrestrictConnection", ({ params }) =>
        withAdminExecutor((executor) =>
          renderEngineErrors(
            executor.accessGroups
              .unrestrictConnection({
                integration: IntegrationSlug.make(params.integration),
                name: ConnectionName.make(params.name),
              })
              .pipe(Effect.map(() => ({ success: true }))),
          ),
        ),
      )
      .handle("listToolkitRestrictions", () =>
        withAdminExecutor((executor) =>
          renderToolkitErrors(
            executor.toolkits
              .listRestrictedToolkits()
              .pipe(Effect.map((restrictions) => ({ restrictions }))),
          ),
        ),
      )
      .handle("restrictToolkit", ({ payload }) =>
        withAdminExecutor((executor) =>
          requireGroupExists(executor, payload.group).pipe(
            Effect.andThen(
              renderToolkitErrors(
                executor.toolkits
                  .setAccessGroup(payload.toolkitId, payload.group)
                  .pipe(Effect.map(() => ({ success: true }))),
              ),
            ),
          ),
        ),
      )
      .handle("unrestrictToolkit", ({ params }) =>
        withAdminExecutor((executor) =>
          renderToolkitErrors(
            executor.toolkits
              .setAccessGroup(params.toolkitId, null)
              .pipe(Effect.map(() => ({ success: true }))),
          ),
        ),
      ),
);

export interface SelfHostAccessGroupsApiDeps {
  readonly betterAuth: BetterAuthHandle;
  readonly db: SelfHostDbHandle;
  readonly mountPrefix: `/${string}`;
}

/**
 * The mountable extension route layer: registers the access-groups routes on
 * the `mountPrefix`-prefixed view of the ambient router (so `/admin/*` is
 * served at `/api/admin/*`). Better Auth, the DB handle, and the execution
 * seams the scoped executor needs are app singletons, provided via
 * `provideRequest` so the handlers' per-request requirement markers are
 * cleared — same shape as the invite plane's layer factory.
 */
export const makeSelfHostAccessGroupsApiLayer = ({
  betterAuth,
  db,
  mountPrefix,
}: SelfHostAccessGroupsApiDeps) => {
  const prefixedRouter = Layer.effect(HttpRouter.HttpRouter)(
    Effect.map(HttpRouter.HttpRouter.asEffect(), (router) => router.prefixed(mountPrefix)),
  );
  const seams = Layer.mergeAll(
    SelfHostDbProvider,
    SelfHostPluginsProvider,
    SelfHostHostConfig,
  ).pipe(Layer.provide(Layer.succeed(SelfHostDb)(db)));
  return HttpApiBuilder.layer(AccessGroupsHttpApi).pipe(
    Layer.provide(AccessGroupsHandlers),
    Layer.provide(prefixedRouter),
    HttpRouter.provideRequest(Layer.mergeAll(Layer.succeed(BetterAuth)(betterAuth), seams)),
  );
};
