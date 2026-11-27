import { defaultUrlPolicy, parseEndpoint } from "@executor-js/utils/url-policy";
import { ApiError } from "@executor-js/utils/api-error";
import {
  AppId,
  AppNotDeployed,
  AppNotFound,
  VersionNotFound,
  HttpUrl,
  RequestRejection,
  StorageError,
  type BuildId,
  type Runtime,
  type RuntimeBuildUnavailable,
} from "@executor-js/sdk/core";
import { AppReturnPath, AppSignInCode, AppSignInId } from "apps/ui/auth/contracts";
import { UiFailed, UiForbidden, UiUnauthorized } from "apps/ui/contracts";
import { Config, Context, type Effect, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { Principal } from "./auth.ts";
import { DesktopReadable } from "./authorization.ts";
import {
  OrganizationForbidden,
  OrganizationId,
  OrganizationReference,
  OrganizationSlug,
  RequireOrganization,
  type OrganizationAccess,
} from "./organization.ts";
export { AppSignInFailure, AppSignInId } from "apps/ui/auth/contracts";

export const appUiAddressScheme = Config.Literals(
  ["nested", "opaque"],
  "EXECUTOR_APP_UI_ADDRESS_SCHEME",
).pipe(Config.withDefault("nested"));
export const appUiEmbedded = Config.Boolean("EXECUTOR_APP_UI_EMBEDDED").pipe(
  Config.withDefault(false),
);

export const AppUiTarget = Schema.Struct({
  app: AppId,
  organization: OrganizationId,
  slug: OrganizationSlug,
  origin: HttpUrl,
});
export type AppUiTarget = typeof AppUiTarget.Type;
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
export const AppUiHostnameLabel = Schema.String.check(
  Schema.isMaxLength(63),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
).pipe(Schema.brand("AppUiHostnameLabel"));
export const AppUiAddressInvalid = ApiError.define({
  tag: "AppUiAddressInvalid",
  status: 422,
  fields: { reason: Schema.Literals(["too_long", "invalid_slug"]) },
  message: ({ reason }) =>
    reason === "too_long"
      ? "The app or organization name makes the app's address longer than a DNS name allows. Shorten one of them."
      : "The app or organization name cannot form a valid app address. Rename one of them.",
});
export type AppUiAddressInvalid = typeof AppUiAddressInvalid.Type;
export const AppUiUnavailable = ApiError.define({
  tag: "AppUiUnavailable",
  status: 503,
  message: "Executor could not read the app's page build or domain right now. Try again.",
});
export type AppUiUnavailable = typeof AppUiUnavailable.Type;
export const AppUiLocation = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    url: HttpUrl,
    name: Schema.String.annotate({ description: "The app's name, for a window or launcher." }),
    icon: Schema.Boolean.annotate({
      description:
        "Whether the active version has ui/icon.svg, served at <url>/_executor/icon.svg.",
    }),
    menuBar: Schema.Boolean.annotate({
      description:
        "Whether the active version has ui/menubar.html, a desktop menu-bar page served at <url>/_executor/menubar.",
    }),
    embedded: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    embedded: Schema.optional(Schema.Boolean),
    url: Schema.Null,
    reason: Schema.Literals(["no_ui", "no_app_domain"]).annotate({
      description:
        "no_ui: the active version has no UI (no index.html), as for tool-only apps. no_app_domain: this Executor has no app domain configured, so no app UI has an address.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literals(["pending", "failed"]),
    url: Schema.Null,
    embedded: Schema.optional(Schema.Boolean),
  }),
]);
export const AppUiAttempt = Schema.Struct({
  kind: Schema.Literal("attempt"),
  target: AppUiTarget,
  returnTo: AppReturnPath,
  proof: Schema.String,
});
export const AppUiGrant = Schema.Struct({
  kind: Schema.Literal("grant"),
  request: AppSignInId,
  target: AppUiTarget,
  parent: Principal.fields.sessionId,
  user: Principal.fields.userId,
});
export const AppUiSession = Schema.Struct({
  kind: Schema.Literal("session"),
  target: AppUiTarget,
  parent: Principal.fields.sessionId,
  user: Principal.fields.userId,
});
export const AppUiRecord = Schema.Union([AppUiAttempt, AppUiGrant, AppUiSession]);

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
    readonly pending: (
      request: AppSignInId,
    ) => Effect.Effect<AppUiTarget, UiUnauthorized | UiFailed>;
    readonly grant: (
      request: AppSignInId,
      target: AppUiTarget,
      principal: Principal,
    ) => Effect.Effect<typeof AppSignInCode.Type, UiFailed>;
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
      { readonly userId: string; readonly impersonatedBy?: string },
      UiUnauthorized | UiForbidden | UiFailed
    >;
  }
>()("hosted/AppSessions") {}

export class HostedAppRuntime extends Context.Service<
  HostedAppRuntime,
  Pick<Runtime, "asset"> & {
    readonly screen?: (build: BuildId) => Effect.Effect<boolean, RuntimeBuildUnavailable>;
  }
>()("hosted/AppRuntime") {}

export const HostedAppUi = HttpApiGroup.make("appUi")
  .add(
    HttpApiEndpoint.get("location", "/api/organizations/:organization/apps/:app/ui", {
      params: { organization: OrganizationReference, app: AppId },
      success: AppUiLocation,
      error: [
        OrganizationForbidden,
        StorageError,
        AppNotFound,
        AppNotDeployed,
        VersionNotFound,
        AppUiAddressInvalid,
        AppUiUnavailable,
      ],
    })
      .annotate(
        OpenApi.Description,
        "Get the canonical private app URL. Fails with AppNotDeployed until the app's first deploy. Returns null when the deployed app has no UI or the host has no app domain. Open the returned URL in a browser to sign in; no separate publish step is needed.",
      )
      .annotate(DesktopReadable, true)
      .middleware(RequireOrganization),
  )
  .add(
    HttpApiEndpoint.get("icon", "/api/organizations/:organization/apps/:app/icon", {
      params: { organization: OrganizationReference, app: AppId },
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      error: [
        OrganizationForbidden,
        StorageError,
        AppNotFound,
        AppNotDeployed,
        VersionNotFound,
        AppUiAddressInvalid,
        AppUiUnavailable,
      ],
    })
      .annotate(
        OpenApi.Description,
        "Get the active version's ui/icon.svg for an app the caller can use, for dashboards. Answers 404 when the app has no deployed icon.",
      )
      .middleware(RequireOrganization),
  );
export const HostedAppUiApi = HttpApi.make("executor-hosted")
  .add(HostedAppUi)
  .middleware(RequestRejection);
