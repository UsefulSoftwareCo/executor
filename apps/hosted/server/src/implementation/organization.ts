import { visibleAccountStatuses } from "./account-identity.ts";
import type { AuthContext } from "@better-auth/core";
import { CurrentToolCallCaller } from "../contracts/tool-call-log.ts";
import type { Principal } from "../contracts/auth.ts";
import { requestAuthentication, requestTombstones } from "./batch-authentication.ts";
import { accountOAuthRedirectUri } from "./auth.ts";
import {
  CurrentUsage,
  isReadMethod,
  observeProductOperation,
  traceProductRead,
} from "../contracts/product-analytics.ts";
import { RequiredAction, CurrentPolicy, DesktopReadable } from "../contracts/authorization.ts";
import {
  fullAuthority,
  permitsAction,
  permitsApp,
  permittedAppIds,
} from "@executor-js/authorization";
import { AppId } from "@executor-js/sdk/core";
import { Context } from "effect";
import {
  currentResourceAuthority,
  policyDatabase,
  visibleAccountsAs,
  visibleAppsAs,
} from "./resource-policy.ts";
import { readOrganizationIconUpload } from "./organization-icons.ts";
import { OrganizationTombstones } from "../contracts/organization-removal.ts";
import { requireOrganizationAdmin } from "./access.ts";
import { appLinkedAccounts, callerLinkedAccounts } from "./app-accounts.ts";
import { CurrentPrincipal, CurrentUserId } from "../contracts/auth.ts";
import {
  recordCaller,
  recordNoSession,
  recordSessionCredential,
  refuse,
  refusedAs,
} from "./auth-telemetry.ts";
import { APIError } from "better-auth/api";
import { ErrorReporter, Effect, Layer, Option, Schema } from "effect";
import { sessionGrantResource } from "@executor-js/mcp-auth/oauth";
import { HttpApiBuilder } from "effect/http-api";
import type { OwnerId } from "@executor-js/sdk/core";
import { HostedApi } from "../contracts/api.ts";
import { CatalogUnavailable, filterCatalog } from "@executor-js/catalog/contracts";
import { HostedCatalog } from "../contracts/catalog.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  type AlsoAccepted,
  BearerAuthentication,
  SessionAuthentication,
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
  publishingScope,
} from "../contracts/organization.ts";

export const sessionPin = (
  adapter: Pick<AuthContext["adapter"], "findOne">,
  principal: Principal,
) =>
  sessionGrantResource(adapter, principal.sessionId).pipe(
    Effect.mapError((error) =>
      error.status === "UNAUTHORIZED"
        ? new OrganizationForbidden()
        : new AuthenticationUnavailable(),
    ),
  );

const pinnedTo = (
  adapter: Pick<AuthContext["adapter"], "findOne">,
  principal: Principal,
  organization: OrganizationId,
) =>
  sessionPin(adapter, principal).pipe(
    Effect.flatMap((pinned) =>
      Option.isSome(pinned) && pinned.value !== organization
        ? Effect.fail(new OrganizationForbidden())
        : Effect.void,
    ),
  );

export const lookupMembership = (
  adapter: Pick<AuthContext["adapter"], "findOne">,
  principal: Principal,
  organization: OrganizationId,
) =>
  Effect.zipWith(
    pinnedTo(adapter, principal, organization),
    memberRole(adapter, principal, organization),
    (_, member) => member,
    { concurrent: true },
  );

const memberRole = (
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

const refuseRemoved = (organization: OrganizationId) =>
  Effect.flatMap(requestTombstones, (removed) => removed(organization)).pipe(
    Effect.mapError(() => new AuthenticationUnavailable()),
    Effect.flatMap((gone) =>
      gone ? refuse("organization_not_found", new OrganizationForbidden()) : Effect.void,
    ),
  );

export const withOrganizationRequest = <E, R>(
  response: (
    namespace: Effect.Effect<string, AuthenticationUnavailable | OrganizationForbidden>,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  action?: import("@executor-js/authorization").Action,
  also: AlsoAccepted = {},
) =>
  Effect.gen(function* () {
    const auth = yield* SessionAuthentication;
    const api = yield* BearerAuthentication;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const headers = new Headers(request.headers);
    const params = yield* HttpRouter.params;
    const reference = yield* Schema.decodeUnknownEffect(OrganizationReference)(
      params.organization,
    ).pipe(
      Effect.mapError(() => new OrganizationForbidden()),
      refusedAs("organization_not_found"),
    );
    if (headers.has("authorization")) {
      if (request.headers.origin !== undefined && request.headers.origin !== auth.origin)
        return yield* refuse("origin_mismatch", new Forbidden());
      const grant = yield* api.authenticate(headers, reference, also);
      yield* recordCaller(grant.access.organization, grant.userId);
      yield* refuseRemoved(grant.access.organization);
      if (grant.desktop !== true && !permitsAction(grant.policy, action))
        return yield* refuse("insufficient_scope", new OrganizationForbidden());
      if (params.app !== undefined) {
        const app = yield* Schema.decodeUnknownEffect(AppId)(params.app).pipe(
          Effect.mapError(() => new OrganizationForbidden()),
          refusedAs("insufficient_scope"),
        );
        if (!permitsApp(grant.policy, app))
          return yield* refuse("insufficient_scope", new OrganizationForbidden());
      }
      if (grant.key !== undefined)
        yield* Effect.annotateCurrentSpan("executor.api_key.id", grant.key.id);
      const scope = Effect.succeed(publishingScope(grant.organizationSlug));
      return (yield* response(scope).pipe(
        Effect.tapCause(ErrorReporter.report),
        Effect.provideService(CurrentPolicy, grant.policy),
        Effect.provideService(CurrentOrganization, grant.access),
        Effect.provideService(CurrentOrganizationNamespace, scope),
        Effect.provideService(CurrentUserId, grant.userId),
        Effect.provideService(CurrentUsage, { source: "api" }),
        Effect.provideService(
          CurrentToolCallCaller,
          grant.key !== undefined
            ? { source: "api-key", sourceId: grant.key.id }
            : { source: "agent", sourceId: grant.grant?.id },
        ),
      )).pipe(HttpServerResponse.setHeader("cache-control", "no-store"));
    }
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.headers.origin !== auth.origin
    )
      return yield* refuse("origin_mismatch", new Forbidden());
    const identity = yield* requestAuthentication(auth);
    const principal = yield* identity.current(headers);
    if (principal === null)
      return yield* Effect.andThen(recordNoSession(headers), Effect.fail(new Unauthorized()));
    yield* recordSessionCredential(principal);
    const organization = yield* identity
      .organization(reference)
      .pipe(refusedAs("organization_not_found"));
    yield* refuseRemoved(organization);
    const membership = yield* identity
      .membership(principal, organization)
      .pipe(refusedAs("not_member"));
    yield* recordCaller(organization, principal.userId);
    const access = {
      organization,
      owner: organizationOwner(organization),
      role: membership.role,
    };
    const scope = auth.organizationSlug(headers, organization).pipe(Effect.map(publishingScope));
    return (yield* response(scope).pipe(
      Effect.tapCause(ErrorReporter.report),
      Effect.provideService(CurrentOrganization, access),
      Effect.provideService(CurrentOrganizationNamespace, scope),
      Effect.provideService(CurrentUserId, principal.userId),
      Effect.provideService(CurrentUsage, { source: "dashboard" }),
      Effect.provideService(CurrentToolCallCaller, { source: "dashboard" }),
      Effect.provideService(CurrentPrincipal, principal),
      Effect.provideService(CurrentPolicy, fullAuthority),
    )).pipe(HttpServerResponse.setHeader("cache-control", "no-store"));
  });

export const requireOrganizationLive = Layer.effect(
  RequireOrganization,
  Effect.gen(function* () {
    const auth = yield* SessionAuthentication;
    const api = yield* BearerAuthentication;
    const tombstones = yield* OrganizationTombstones;
    return (response, { endpoint, group }) =>
      withOrganizationRequest(
        () => {
          const operation = {
            area: group.identifier,
            operation: endpoint.identifier,
            method: endpoint.method,
          };
          return isReadMethod(endpoint.method)
            ? traceProductRead(operation, response)
            : observeProductOperation(operation, response, (result) => ({
                status_code: result.status,
                ok: result.status < 400,
                outcome: result.status < 400 ? "success" : "failure",
              }));
        },
        Context.getOrUndefined(endpoint.annotations, RequiredAction),
        { desktop: Context.get(endpoint.annotations, DesktopReadable) },
      ).pipe(
        Effect.provideService(SessionAuthentication, auth),
        Effect.provideService(BearerAuthentication, api),
        Effect.provideService(OrganizationTombstones, tombstones),
      );
  }),
);

export const noOrganizationRemovals = Layer.succeed(OrganizationTombstones, () =>
  Effect.succeed(false),
);

export const inventory = (owner: OwnerId) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const policy = yield* CurrentPolicy;
    const listedApps = yield* executor.apps.list({ owner, ids: permittedAppIds(policy) });
    const actor = yield* currentResourceAuthority;
    const apps = yield* visibleAppsAs(actor, listedApps);
    const accounts = permitsAction(policy, "read")
      ? yield* executor.accounts
          .list({ owner })
          .pipe(Effect.flatMap((listed) => visibleAccountsAs(actor, listed)))
      : [];
    const ids = apps.map((app) => app.id);
    const linked = yield* callerLinkedAccounts(ids);
    const links = [
      ...new Map(
        linked.map((link) => [`${link.app}\u0000${link.id}`, { app: link.app, account: link.id }]),
      ).values(),
    ];
    const appLinks = (yield* appLinkedAccounts(yield* policyDatabase, ids)).map((link) => ({
      app: link.app,
      requirement: link.requirement,
      account: link.id,
      provider: link.provider,
      label: link.label,
    }));
    const checked = [
      ...new Map(
        [...links, ...appLinks].map((link) => [
          `${link.app}\u0000${link.account}`,
          { app: link.app, account: link.account },
        ]),
      ).values(),
    ];
    const health = new Map(
      (accounts.length === 0
        ? []
        : yield* executor.accounts.listHealth({ owner, links: checked })
      ).map((entry) => [entry.account, entry]),
    );
    const statuses = yield* visibleAccountStatuses(
      accounts.map((account) => {
        const checks = health.get(account.id);
        return checks === undefined ? { account } : { account, health: checks };
      }),
    );
    const withHealth = (listedAccounts: typeof accounts) => {
      const selected = new Set(listedAccounts.map((account) => account.id));
      return statuses
        .filter((entry) => selected.has(entry.account.id))
        .map(({ account, health }) => (health === undefined ? account : { ...account, health }));
    };
    if (policy.tools.kind === "all")
      return { apps, accounts: withHealth(accounts), links, appLinks };
    const selected = new Set(links.map((link) => link.account));
    return {
      apps,
      accounts: withHealth(accounts.filter((account) => selected.has(account.id))),
      links,
      appLinks,
    };
  });
export const hostedOrganizationHandlers = HttpApiBuilder.group(
  HostedApi,
  "organization",
  (handlers) =>
    Effect.gen(function* () {
      const authentication = yield* SessionAuthentication;
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
        .handle("catalog", ({ query }) =>
          Effect.flatMap(HostedCatalog, (catalog) => catalog.list).pipe(
            Effect.flatMap((listing) =>
              listing.feed.status === "unavailable"
                ? Effect.fail(new CatalogUnavailable())
                : Effect.succeed(filterCatalog(listing.apps, query)),
            ),
          ),
        )
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
