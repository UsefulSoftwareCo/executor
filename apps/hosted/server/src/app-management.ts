import { SqlClient } from "effect/unstable/sql";
import { GroupDatabase } from "./contracts/groups.ts";
import { CurrentUserId } from "./contracts/auth.ts";
import { OrganizationId } from "./contracts/organization.ts";
import { resourceAuthority, applicationAccess } from "./implementation/resource-policy.ts";
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
import { Effect, Encoding, Layer, Schema } from "effect";
import { ApiAuthentication, Authentication } from "./contracts/auth.ts";
import { OrganizationReference, CurrentOrganization } from "./contracts/organization.ts";

/** Capture only the host database; identity and group grants are checked for every authoring operation. */
export const hostedAppCapabilities = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (app: App, identity: Context.Service.Shape<typeof AppIdentity>) =>
    Effect.gen(function* () {
      const organization = yield* Schema.decodeUnknownEffect(OrganizationId)(identity.scope).pipe(
        Effect.mapError(() => new StorageError()),
      );
      if (app.owner !== `organization:${organization}`)
        return yield* new AppAccessDenied({ reason: "forbidden" });
      const actor = yield* resourceAuthority(organization, identity.actor);
      const access = yield* applicationAccess(app.id, actor);
      return {
        visible: access.canUse,
        manage: access.canManage,
        edit: access.canManage,
      } satisfies AppCapabilities;
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
              endpoint.identifier === "history" ||
              endpoint.identifier === "published"
            ? "read"
            : "manage",
      ).pipe(
        Effect.provideService(Authentication, auth),
        Effect.provideService(ApiAuthentication, api),
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
            const decoded = yield* Effect.fromResult(
              Encoding.decodeBase64String(authorization.slice(6)),
            );
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
            namespace: grant.organizationSlug,
            canWrite: permitsAction(grant.policy, "manage"),
            appIds: permittedAppIds(grant.policy),
            protectedApps: [],
          };
        }).pipe(
          Effect.mapError((error) =>
            Schema.is(AppAccessDenied)(error)
              ? error
              : new AppAccessDenied({ reason: "authentication" }),
          ),
        ),
    });
  }),
);
