import type { AuthContext } from "@better-auth/core";
import type { Principal } from "../contracts/auth.ts";
import { type Profile } from "@executor-js/sdk/core";
import { accountOAuthRedirectUri } from "./auth.ts";
import { CurrentUsage, observeProductOperation } from "../contracts/product-analytics.ts";
import { RequiredAction, CurrentAuthorization } from "../contracts/authorization.ts";
import {
  fullAuthority,
  permitsAction,
  permitsApp,
  permittedAppIds,
} from "@executor-js/authorization";
import { AppId } from "@executor-js/sdk/core";
import { Context } from "effect";
import { visibleApps, visibleAccounts } from "./resource-policy.ts";
import { readOrganizationIconUpload } from "./organization-icons.ts";
import { OrganizationTombstones } from "../contracts/organization-removal.ts";
import { requireOrganizationAdmin } from "./access.ts";
import { CurrentPrincipal, CurrentUserId } from "../contracts/auth.ts";
import { APIError } from "better-auth/api";
import { ErrorReporter, Effect, Layer, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { OwnerId } from "@executor-js/sdk/core";
import { HostedApi } from "../contracts/api.ts";
import { HostedCatalog } from "../contracts/catalog.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  ApiAuthentication,
  Authentication,
  AuthenticationUnavailable,
  Forbidden,
  Unauthorized,
} from "../contracts/auth.ts";
import {
  CurrentOrganization,
  CurrentOrganizationNamespace,
  OrganizationIcons,
  OrganizationId,
  OrganizationForbidden,
  OrganizationReference,
  OrganizationRole,
  RequireOrganization,
  organizationOwner,
} from "../contracts/organization.ts";

/** Read current membership once after native session verification; never retain roles between requests. */
export const lookupMembership = (
  adapter: Pick<AuthContext["adapter"], "findOne">,
  principal: Principal,
  organization: OrganizationId,
) =>
  Effect.tryPromise({
    try: () =>
      adapter.findOne({
        model: "member",
        where: [
          { field: "userId", value: principal.userId },
          { field: "organizationId", value: organization },
        ],
        select: ["role"],
      }),
    catch: () => new AuthenticationUnavailable(),
  }).pipe(
    Effect.flatMap((member) =>
      Schema.decodeUnknownEffect(Schema.Struct({ role: OrganizationRole }))(member).pipe(
        Effect.mapError(() => new OrganizationForbidden()),
      ),
    ),
  );

/** Resolve a checked organization ID for canonical return links without session selection. */
export const lookupOrganizationSlug = (call: () => Promise<unknown>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) =>
      cause instanceof APIError && (cause.statusCode === 401 || cause.statusCode === 403)
        ? new OrganizationForbidden()
        : new AuthenticationUnavailable(),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ slug: Schema.NonEmptyString }))),
    Effect.map((organization) => organization.slug),
    Effect.catchTag("SchemaError", () => Effect.fail(new AuthenticationUnavailable())),
  );

/**
 * The single choke point for a removed organization. Removal is durable and
 * asynchronous, so a tombstone stands in for the records its workflow has not
 * deleted yet. Both authentication paths pass through here, so one check hides
 * the organization from membership, inventory, apps, accounts and MCP alike.
 * A tombstone read that fails refuses the request rather than serving an
 * organization that is being erased.
 */
const refuseRemoved = (organization: OrganizationId) =>
  Effect.flatMap(OrganizationTombstones, (removed) => removed(organization)).pipe(
    Effect.mapError(() => new AuthenticationUnavailable()),
    Effect.flatMap((gone) => (gone ? Effect.fail(new OrganizationForbidden()) : Effect.void)),
  );

/** Access resolves only the explicit route ID or slug. Shared session preferences never participate. */
export const withOrganizationRequest = <E, R>(
  response: (
    namespace: Effect.Effect<string, AuthenticationUnavailable | OrganizationForbidden>,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  action?: import("@executor-js/authorization").Action,
) =>
  Effect.gen(function* () {
    const auth = yield* Authentication;
    const api = yield* ApiAuthentication;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const headers = new Headers(request.headers);
    const params = yield* HttpRouter.params;
    const reference = yield* Schema.decodeUnknownEffect(OrganizationReference)(
      params.organization,
    ).pipe(Effect.mapError(() => new OrganizationForbidden()));
    if (headers.has("authorization")) {
      if (request.headers.origin !== undefined && request.headers.origin !== auth.origin)
        return yield* new Forbidden();
      const grant = yield* api.authenticate(headers, reference);
      yield* refuseRemoved(grant.access.organization);
      if (!permitsAction(grant.policy, action)) return yield* new OrganizationForbidden();
      if (params.app !== undefined) {
        const app = yield* Schema.decodeUnknownEffect(AppId)(params.app).pipe(
          Effect.mapError(() => new OrganizationForbidden()),
        );
        if (!permitsApp(grant.policy, app)) return yield* new OrganizationForbidden();
      }
      if (grant.key !== undefined)
        yield* Effect.annotateCurrentSpan({
          "executor.api_key.id": grant.key.id,
          "executor.user.id": grant.userId,
        });
      return (yield* response(Effect.succeed(grant.organizationSlug)).pipe(
        Effect.tapCause(ErrorReporter.report),
        Effect.provideService(CurrentAuthorization, grant.policy),
        Effect.provideService(CurrentOrganization, grant.access),
        Effect.provideService(CurrentOrganizationNamespace, Effect.succeed(grant.organizationSlug)),
        Effect.provideService(CurrentUserId, grant.userId),
        Effect.provideService(CurrentUsage, { source: "api" }),
      )).pipe(HttpServerResponse.setHeader("cache-control", "no-store"));
    }
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.headers.origin !== auth.origin
    )
      return yield* new Forbidden();
    const principal = yield* auth.current(headers);
    if (principal === null) return yield* new Unauthorized();
    const organization = yield* auth.organization(reference);
    yield* refuseRemoved(organization);
    const membership = yield* auth.membership(principal, organization);
    const access = {
      organization,
      owner: organizationOwner(organization),
      role: membership.role,
    };
    return (yield* response(auth.organizationSlug(headers, organization)).pipe(
      Effect.tapCause(ErrorReporter.report),
      Effect.provideService(CurrentOrganization, access),
      Effect.provideService(
        CurrentOrganizationNamespace,
        auth.organizationSlug(headers, organization),
      ),
      Effect.provideService(CurrentUserId, principal.userId),
      Effect.provideService(CurrentUsage, { source: "dashboard" }),
      Effect.provideService(CurrentPrincipal, principal),
      Effect.provideService(CurrentAuthorization, fullAuthority),
    )).pipe(HttpServerResponse.setHeader("cache-control", "no-store"));
  });

/** Apply the current organization checks without translating away product failures. */
export const requireOrganizationLive = Layer.effect(
  RequireOrganization,
  Effect.gen(function* () {
    const auth = yield* Authentication;
    const api = yield* ApiAuthentication;
    return (response, { endpoint, group }) =>
      withOrganizationRequest(
        () =>
          observeProductOperation(
            { area: group.identifier, operation: endpoint.identifier, method: endpoint.method },
            response,
            (result) => ({
              status_code: result.status,
              ok: result.status < 400,
              outcome: result.status < 400 ? "success" : "failure",
            }),
          ),
        Context.getOrUndefined(endpoint.annotations, RequiredAction),
      ).pipe(
        Effect.provideService(Authentication, auth),
        Effect.provideService(ApiAuthentication, api),
      );
  }),
);

/** List organization metadata through the SDK without evaluating app code. */
export const inventory = (owner: OwnerId) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const policy = yield* CurrentAuthorization;
    const apps = yield* executor.apps
      .list({ owner, ids: permittedAppIds(policy) })
      .pipe(Effect.flatMap(visibleApps));
    const accounts = permitsAction(policy, "read")
      ? yield* executor.accounts.list({ owner }).pipe(Effect.flatMap(visibleAccounts))
      : [];
    const user = yield* CurrentUserId;
    if (user === undefined) return yield* new OrganizationForbidden();
    const listedProfiles = yield* executor.apps.profiles.listMany({
      apps: apps.map((app) => app.id),
      owner,
      subject: user,
    });
    // Keep inventory's app-first ordering while reading all profile rows together.
    const byApp = new Map<AppId, Profile[]>();
    for (const profile of listedProfiles) {
      const existing = byApp.get(profile.app);
      if (existing === undefined) byApp.set(profile.app, [profile]);
      else existing.push(profile);
    }
    const profiles = apps.flatMap((app) => byApp.get(app.id) ?? []);
    if (policy.tools.kind === "all") return { apps, accounts, profiles };
    const selected = new Set(
      profiles.flatMap((profile) =>
        Object.values(profile.accounts).flatMap((value) =>
          typeof value === "string" ? [value] : value,
        ),
      ),
    );
    return { apps, accounts: accounts.filter((account) => selected.has(account.id)), profiles };
  });
/** Organization routes do not own app/account operations. */
export const hostedOrganizationHandlers = HttpApiBuilder.group(
  HostedApi,
  "organization",
  (handlers) =>
    Effect.gen(function* () {
      const authentication = yield* Authentication;
      return handlers
        .handleRaw("uploadIcon", () =>
          Effect.gen(function* () {
            const organization = yield* requireOrganizationAdmin;
            const image = yield* readOrganizationIconUpload;
            return yield* (yield* OrganizationIcons).upload(organization.organization, image);
          }),
        )
        .handle("icon", ({ params }) =>
          Effect.gen(function* () {
            const organization = yield* CurrentOrganization;
            const image = yield* (yield* OrganizationIcons).read(
              organization.organization,
              params.key,
            );
            return HttpServerResponse.uint8Array(image.bytes, {
              contentType: image.contentType,
              headers: { "x-content-type-options": "nosniff" },
            });
          }),
        )
        .handle("catalog", () => Effect.flatMap(HostedCatalog, (catalog) => catalog.list))
        .handle("access", () => CurrentOrganization)
        .handle("inventory", () =>
          Effect.gen(function* () {
            const organization = yield* CurrentOrganization;
            return {
              ...(yield* inventory(organization.owner)),
              accountSetup: { redirectUri: accountOAuthRedirectUri(authentication) },
            };
          }),
        );
    }),
);
