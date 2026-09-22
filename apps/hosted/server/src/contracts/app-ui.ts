/** Hosted app pages use scoped sessions, independent of dashboard and management API credentials. */
import { defaultUrlPolicy, parseEndpoint } from "@executor-js/utils/url-policy";
import { AppId, HttpUrl, type Runtime } from "@executor-js/sdk/core";
import { AppReturnPath, AppSignInCode, AppSignInId } from "apps/ui/auth/contracts";
import { UiFailed, UiForbidden, UiUnauthorized } from "apps/ui/contracts";
import { Context, type Effect, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Principal, RequireUser } from "./auth.ts";
import {
  OrganizationId,
  OrganizationReference,
  OrganizationSlug,
  RequireOrganization,
  type OrganizationAccess,
} from "./organization.ts";
export { AppSignInId } from "apps/ui/auth/contracts";

/** Immutable ownership plus the exact current browser origin. Slug reuse cannot transfer a session. */
export const AppUiTarget = Schema.Struct({
  app: AppId,
  organization: OrganizationId,
  slug: OrganizationSlug,
  origin: HttpUrl,
});
export type AppUiTarget = typeof AppUiTarget.Type;
/**
 * A wildcard DNS base, separate from the dashboard origin; HTTP is limited to loopback development.
 * This is an origin the host serves to browsers, not a destination the host fetches, so it takes
 * the fixed transport rule rather than the deployment's egress policy: an operator exception for
 * reaching an internal API must not also widen the origins app UIs can be published on.
 */
export const AppUiBaseUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    const url = parseEndpoint(value, defaultUrlPolicy);
    return (
      url !== undefined &&
      url.origin === value &&
      /^[a-z0-9.-]+$/.test(url.hostname) &&
      !/^[\d.]+$/.test(url.hostname)
    );
  }),
).pipe(Schema.brand("AppUiBaseUrl"));
export type AppUiBaseUrl = typeof AppUiBaseUrl.Type;
/** One DNS label; the app and team are separate labels. */
export const AppUiHostnameLabel = Schema.String.check(
  Schema.isMaxLength(63),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
).pipe(Schema.brand("AppUiHostnameLabel"));
/** App and organization names cannot be silently shortened or changed to create a browser origin. */
export class AppUiAddressInvalid extends Schema.TaggedError<AppUiAddressInvalid>()(
  "AppUiAddressInvalid",
  { reason: Schema.Literals(["too_long", "invalid_slug"]) },
  { httpApiStatus: 422 },
) {}
/** Domain readiness is separate from app deployment and authorization. A pending domain has no usable link. */
export const AppUiLocation = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready"), url: HttpUrl }),
  Schema.Struct({
    status: Schema.Literals(["unavailable", "pending", "failed"]),
    url: Schema.Null,
  }),
]);
/** A browser started this attempt on an app origin; only a digest of its HttpOnly proof is retained. */
export const AppUiAttempt = Schema.Struct({
  kind: Schema.Literal("attempt"),
  target: AppUiTarget,
  returnTo: AppReturnPath,
  proof: Schema.String,
});
/** A short-lived authorization code refers to the parent login, never its bearer token. */
export const AppUiGrant = Schema.Struct({
  kind: Schema.Literal("grant"),
  request: AppSignInId,
  target: AppUiTarget,
  parent: Principal.fields.sessionId,
  user: Principal.fields.userId,
});
/** App sessions retain only scoped authority; every use checks current login and membership. */
export const AppUiSession = Schema.Struct({
  kind: Schema.Literal("session"),
  target: AppUiTarget,
  parent: Principal.fields.sessionId,
  user: Principal.fields.userId,
});
/** Versioned records live in Better Auth's existing expiring verification store. */
export const AppUiRecord = Schema.Union([AppUiAttempt, AppUiGrant, AppUiSession]);

/** Product authentication operations backed by the host's Better Auth instance. */
export class HostedAppSessions extends Context.Service<
  HostedAppSessions,
  {
    readonly organization: (
      find:
        | { readonly id: OrganizationId }
        | { readonly slug: OrganizationSlug }
        | { readonly reference: typeof OrganizationReference.Type },
    ) => Effect.Effect<
      { readonly id: OrganizationId; readonly slug: OrganizationSlug },
      UiForbidden | UiFailed
    >;
    readonly access: (
      principal: Principal,
      target: Pick<AppUiTarget, "organization">,
    ) => Effect.Effect<OrganizationAccess, UiUnauthorized | UiForbidden | UiFailed>;
    readonly begin: (
      target: AppUiTarget,
      returnTo: AppReturnPath,
    ) => Effect.Effect<
      { readonly request: AppSignInId; readonly proof: typeof AppSignInCode.Type },
      UiFailed
    >;
    readonly authorize: (
      request: AppSignInId,
      principal: Principal,
    ) => Effect.Effect<
      { readonly target: AppUiTarget; readonly code: typeof AppSignInCode.Type },
      UiUnauthorized | UiForbidden | UiFailed
    >;
    readonly complete: (
      target: AppUiTarget,
      request: AppSignInId,
      code: typeof AppSignInCode.Type,
      proof: typeof AppSignInCode.Type,
    ) => Effect.Effect<
      {
        readonly token: typeof AppSignInCode.Type;
        readonly returnTo: AppReturnPath;
        readonly expiresAt: Date;
      },
      UiUnauthorized | UiForbidden | UiFailed
    >;
    readonly current: (
      target: AppUiTarget,
      token: typeof AppSignInCode.Type,
    ) => Effect.Effect<
      OrganizationAccess & { readonly userId: string },
      UiUnauthorized | UiForbidden | UiFailed
    >;
  }
>()("hosted/AppSessions") {}

/** Asset access uses the same retained runtime that built and executes the app. */
export class HostedAppRuntime extends Context.Service<HostedAppRuntime, Pick<Runtime, "asset">>()(
  "hosted/AppRuntime",
) {}

/** URL discovery uses organization grants; browser authorization still requires a user session. */
export const HostedAppUi = HttpApiGroup.make("appUi")
  .add(
    HttpApiEndpoint.get("location", "/api/organizations/:organization/apps/:app/ui", {
      params: { organization: OrganizationReference, app: AppId },
      success: AppUiLocation,
      error: [UiForbidden, UiFailed, AppUiAddressInvalid],
    })
      .annotate(
        OpenApi.Description,
        "Get the canonical private app URL. Returns null when the app has no UI or the host has no app domain. Open the returned URL in a browser to sign in; no separate publish step is needed.",
      )
      .middleware(RequireOrganization),
  )
  .add(
    HttpApiEndpoint.post("authorize", "/api/app-ui/authorize", {
      payload: Schema.Struct({ request: AppSignInId }),
      success: Schema.Struct({ url: Schema.RedactedFromValue(HttpUrl) }),
      error: [UiUnauthorized, UiForbidden, UiFailed, AppUiAddressInvalid],
    }).middleware(RequireUser),
  );
/** A browser client can consume the same narrow contract without importing a host's full API. */
export const HostedAppUiApi = HttpApi.make("executor-hosted").add(HostedAppUi);
