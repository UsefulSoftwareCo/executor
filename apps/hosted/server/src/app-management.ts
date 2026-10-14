import { SqlClient } from "effect/sql";
import { GroupDatabase } from "./contracts/groups.ts";
import { CurrentUserId } from "./contracts/auth.ts";
import { OrganizationId } from "./contracts/organization.ts";
import { resourceAuthorityForApps } from "./implementation/resource-policy.ts";
import { StorageError, type App } from "@executor-js/sdk/core";
import type { AppCapabilities } from "@executor-js/app-management/contracts";
import { Context } from "effect";
import { permitsAction, permittedAppIds } from "@executor-js/authorization";
import { CurrentAuthorization } from "./contracts/authorization.ts";
import { OrganizationForbidden } from "./contracts/organization.ts";
import { requireOrganizationAdmin } from "./implementation/access.ts";
import { HostedAppAccess } from "./contracts/app-management.ts";
import { withOrganizationRequest } from "./implementation/organization.ts";
/** Hosted app source uses current organization membership and existing API OAuth grants. */
import { AppIdentity, AppGitAccess, AppAccessDenied } from "@executor-js/app-management";
import { Effect, Layer, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { ApiAuthentication, Authentication } from "./contracts/auth.ts";
import { OrganizationTombstones } from "./contracts/organization-removal.ts";
import {
  OrganizationReference,
  CurrentOrganization,
  publishingScope,
} from "./contracts/organization.ts";

/**
 * Capture only the host database; identity and group grants are checked for every authoring
 * operation. Membership and every app's policy are read once for the whole list.
 */
export const hostedAppCapabilities = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (apps: ReadonlyArray<App>, identity: Context.Service.Shape<typeof AppIdentity>) =>
    Effect.gen(function* () {
      if (apps.length === 0) return [];
      const organization = yield* Schema.decodeUnknownEffect(OrganizationId)(identity.scope).pipe(
        Effect.mapError(() => new StorageError()),
      );
      if (apps.some((app) => app.owner !== `organization:${organization}`))
        return yield* new AppAccessDenied({ reason: "forbidden" });
      // Membership and every policy are read in one statement, so they share one snapshot.
      const { access: found } = yield* resourceAuthorityForApps(
        organization,
        identity.actor,
        apps.map((app) => app.id),
      );
      const policies = new Map(found.map((access) => [access.app, access]));
      return yield* Effect.forEach(apps, (app) => {
        const access = policies.get(app.id);
        // A missing policy denies access, as it does for one app.
        return access === undefined
          ? Effect.fail(new AppAccessDenied({ reason: "forbidden" }))
          : Effect.succeed({
              visible: access.canUse,
              manage: access.canManage,
              edit: access.canManage,
            } satisfies AppCapabilities);
      });
    }).pipe(
      Effect.provideService(GroupDatabase, Effect.succeed(sql)),
      Effect.catchTag("OrganizationForbidden", () =>
        Effect.fail(new AppAccessDenied({ reason: "forbidden" })),
      ),
    );
});

export const hostedAppAccess = Layer.effect(
  HostedAppAccess,
  Effect.gen(function* () {
    const api = yield* ApiAuthentication;
    const auth = yield* Authentication;
    const tombstones = yield* OrganizationTombstones;
    return (response, { endpoint }) =>
      withOrganizationRequest(
        (namespace) =>
          Effect.gen(function* () {
            const access = yield* ["publish", "published", "unpublish"].includes(
              endpoint.identifier,
            )
              ? requireOrganizationAdmin
              : CurrentOrganization;
            const policy = yield* CurrentAuthorization;
            if (
              ["create", "copy", "published", "unpublish"].includes(endpoint.identifier) &&
              policy.tools.kind !== "all"
            )
              return yield* new OrganizationForbidden();
            return yield* response.pipe(
              Effect.provideService(AppIdentity, {
                owner: access.owner,
                readOwner: access.owner,
                scope: access.organization,
                namespace: yield* namespace,
                canWrite: permitsAction(policy, "manage"),
                actor: yield* CurrentUserId,
                protectedApps: [],
                appIds: permittedAppIds(policy),
              }),
            );
          }),
        endpoint.identifier === "list" || endpoint.identifier === "catalog"
          ? "discover"
          : endpoint.identifier === "authoring" ||
              endpoint.identifier === "source" ||
              endpoint.identifier === "sourceDisplay" ||
              endpoint.identifier === "sourceDisplayFile" ||
              endpoint.identifier === "history" ||
              endpoint.identifier === "published"
            ? "read"
            : "manage",
      ).pipe(
        Effect.provideService(Authentication, auth),
        Effect.provideService(ApiAuthentication, api),
        Effect.provideService(OrganizationTombstones, tombstones),
      );
  }),
);

/** Git Basic passwords carry API tokens; browser cookies cannot authorize a Git push or clone. */
export const hostedAppGitAccess = Layer.effect(
  AppGitAccess,
  Effect.gen(function* () {
    const api = yield* ApiAuthentication;
    return AppGitAccess.of({
      authenticate: (request, scope) =>
        Effect.gen(function* () {
          if (request.headers.origin !== undefined)
            return yield* new AppAccessDenied({ reason: "forbidden" });
          const authorization = request.headers.authorization;
          if (authorization === undefined)
            return yield* new AppAccessDenied({ reason: "authentication" });
          let token: string;
          if (authorization.startsWith("Basic ")) {
            const decoded = yield* Effect.fromResult(Base64.decodeString(authorization.slice(6)));
            const colon = decoded.indexOf(":");
            if (colon < 0) return yield* new AppAccessDenied({ reason: "authentication" });
            token = decoded.slice(colon + 1);
          } else if (authorization.startsWith("Bearer ")) token = authorization.slice(7);
          else return yield* new AppAccessDenied({ reason: "authentication" });
          const grant = yield* api.authenticate(
            new Headers({ authorization: `Bearer ${token}` }),
            yield* Schema.decodeUnknownEffect(OrganizationReference)(scope),
          );
          if (
            (grant.access.organization !== scope && grant.organizationSlug !== scope) ||
            !permitsAction(grant.policy, "read")
          )
            return yield* new AppAccessDenied({ reason: "forbidden" });
          return {
            owner: grant.access.owner,
            actor: grant.userId,
            readOwner: grant.access.owner,
            scope: grant.access.organization,
            namespace: publishingScope(grant.organizationSlug),
            canWrite: permitsAction(grant.policy, "manage"),
            appIds: permittedAppIds(grant.policy),
            protectedApps: [],
          };
        }).pipe(
          // Git reports a 401 as a failed sign-in, so only a credential the host refused is one.
          // A session check that could not run is retryable and leaves the credential in place.
          Effect.catchTags({
            Unauthorized: () => Effect.fail(new AppAccessDenied({ reason: "authentication" })),
            OrganizationForbidden: () => Effect.fail(new AppAccessDenied({ reason: "forbidden" })),
            AuthenticationUnavailable: () => Effect.fail(new StorageError()),
          }),
          Effect.mapError((error) =>
            Schema.is(AppAccessDenied)(error) || Schema.is(StorageError)(error)
              ? error
              : new AppAccessDenied({ reason: "authentication" }),
          ),
        ),
    });
  }),
);
