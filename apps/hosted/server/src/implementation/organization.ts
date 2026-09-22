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
import { requireOrganizationAdmin } from "./access.ts";
import { CurrentPrincipal, CurrentUserId } from "../contracts/auth.ts";
import { APIError } from "better-auth/api";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { OwnerId } from "@executor-js/sdk/core";
import { HostedApi } from "../contracts/api.ts";
import { HostedCatalog } from "../contracts/catalog.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { OrganizationDefaults } from "../contracts/organization-defaults.ts";
import { Cookies, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
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
  OrganizationForbidden,
  OrganizationReference,
  OrganizationRole,
  RequireOrganization,
  organizationOwner,
} from "../contracts/organization.ts";

/** Adapt the public Better Auth role endpoint, preserving any renewed session cookies. */
export const lookupMembership = (
  call: () => Promise<{ headers: Headers; response: { role: string } }>,
) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) =>
      cause instanceof APIError && (cause.statusCode === 401 || cause.statusCode === 403)
        ? new OrganizationForbidden()
        : new AuthenticationUnavailable(),
  }).pipe(
    Effect.flatMap(({ headers, response }) =>
      Schema.decodeUnknownEffect(OrganizationRole)(response.role).pipe(
        Effect.map((role) => ({ role, headers })),
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
        Effect.provideService(CurrentAuthorization, grant.policy),
        Effect.provideService(CurrentOrganization, grant.access),
        Effect.provideService(CurrentOrganizationNamespace, Effect.succeed(grant.organizationSlug)),
        Effect.provideService(CurrentUserId, grant.userId),
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
    const membership = yield* auth.membership(headers, organization);
    const access = {
      organization,
      owner: organizationOwner(organization),
      role: membership.role,
    };
    return (yield* response(auth.organizationSlug(headers, organization)).pipe(
      Effect.provideService(CurrentOrganization, access),
      Effect.provideService(
        CurrentOrganizationNamespace,
        auth.organizationSlug(headers, organization),
      ),
      Effect.provideService(CurrentUserId, principal.userId),
      Effect.provideService(CurrentPrincipal, principal),
      Effect.provideService(CurrentAuthorization, fullAuthority),
    )).pipe(
      HttpServerResponse.mergeCookies(Cookies.fromSetCookie(membership.headers.getSetCookie())),
      HttpServerResponse.setHeader("cache-control", "no-store"),
    );
  });

/** Apply the current organization checks without translating away product failures. */
export const requireOrganizationLive = Layer.effect(
  RequireOrganization,
  Effect.gen(function* () {
    const auth = yield* Authentication;
    const api = yield* ApiAuthentication;
    return (response, { endpoint }) =>
      withOrganizationRequest(
        () => response,
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
    if (policy.tools.kind === "all") return { apps, accounts };
    const selected = new Set(
      apps.flatMap((app) =>
        Object.values(app.accounts).flatMap((value) =>
          typeof value === "string" ? [value] : value,
        ),
      ),
    );
    return { apps, accounts: accounts.filter((account) => selected.has(account.id)) };
  });
/** Initialize explicit system defaults before either inventory representation is returned. */
export const initializeOrganizationInventory = (authentication: typeof Authentication.Service) =>
  Effect.gen(function* () {
    const organization = yield* CurrentOrganization;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const headers = new Headers(request.headers);
    const principal =
      organization.role === "member" || headers.has("authorization") || !headers.has("cookie")
        ? null
        : Option.getOrUndefined(yield* Effect.serviceOption(CurrentPrincipal));
    if ((yield* CurrentAuthorization).tools.kind === "all")
      yield* (yield* OrganizationDefaults)(
        organization.organization,
        principal == null
          ? undefined
          : {
              userId: principal.userId,
              name: principal.name,
              key: authentication
                .apiKey(headers)
                .pipe(Effect.catchTag("OrganizationForbidden", () => Effect.fail(new Forbidden()))),
            },
      );
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
          initializeOrganizationInventory(authentication).pipe(
            Effect.andThen(
              Effect.flatMap(CurrentOrganization, (organization) => inventory(organization.owner)),
            ),
          ),
        );
    }),
);
