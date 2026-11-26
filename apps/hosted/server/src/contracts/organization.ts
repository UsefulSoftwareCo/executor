import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { ApiError } from "@executor-js/utils/api-error";
import { RequiredAction } from "./authorization.ts";
import { CatalogEntry, CatalogQuery, CatalogUnavailable } from "@executor-js/catalog/contracts";
import { Context, Effect, Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  OpenApi,
} from "effect/http-api";
import {
  Account,
  AccountHealth,
  AccountId,
  App,
  AppId,
  OwnerId,
  ProviderId,
  HttpUrl,
  StorageError,
  publishingDomain,
} from "@executor-js/sdk/core";
import {
  OrganizationIconUrl,
  OrganizationIconKey,
  UploadedOrganizationIcon,
  type OrganizationIconContentType,
} from "./organization-icon.ts";
import {
  AuthenticationUnavailable,
  Forbidden,
  Unauthorized,
  RequireBrowserSession,
} from "./auth.ts";

export const OrganizationId = Schema.NonEmptyString.pipe(Schema.brand("OrganizationId"));
export type OrganizationId = typeof OrganizationId.Type;
export const organizationSlugMaxLength = 45;
export const OrganizationSlug = Schema.String.check(
  Schema.isMaxLength(organizationSlugMaxLength),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
).pipe(Schema.brand("OrganizationSlug"));
export type OrganizationSlug = typeof OrganizationSlug.Type;
export const organizationHandle = (name: string, maxLength = organizationSlugMaxLength) =>
  name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
export const OrganizationReference = Schema.Union([OrganizationId, OrganizationSlug]);
export type OrganizationReference = typeof OrganizationReference.Type;
export const OrganizationLogo = Schema.NullOr(
  Schema.String.check(
    Schema.makeFilter((value) => {
      try {
        if (Schema.is(OrganizationIconUrl)(value)) return true;
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      } catch {
        return false;
      }
    }),
  ),
);
export const OrganizationDetailsUpdate = Schema.Struct({
  name: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120), Schema.isPattern(/\S/u)),
  ),
  slug: Schema.optionalKey(OrganizationSlug),
  logo: Schema.optionalKey(OrganizationLogo),
}).check(
  Schema.makeFilter(
    (data) => data.name !== undefined || data.slug !== undefined || data.logo !== undefined,
  ),
);
export const OrganizationRole = Schema.Literals(["owner", "admin", "member"]);
export const OrganizationAccess = Schema.Struct({
  organization: OrganizationId,
  role: OrganizationRole,
  owner: OwnerId,
});
export type OrganizationAccess = typeof OrganizationAccess.Type;
export const OrganizationForbidden = UserFacingError.define({
  tag: "OrganizationForbidden",
  status: 403,
  title: "Organization access denied",
  description: "Your current membership or role does not allow this action in this organization.",
  recovery: {
    action:
      "Check that you’re using the right account and organization. Copy the fix prompt into your agent to investigate the missing access.",
    instructions:
      "Check the signed-in identity, organization, and permission required for the failed operation. Identify a wrong context or a missing access grant and the supported way to resolve it. Do not bypass authorization or assume changing integration code can grant access.",
  },
});
export type OrganizationForbidden = typeof OrganizationForbidden.Type;
export class CurrentOrganization extends Context.Service<CurrentOrganization, OrganizationAccess>()(
  "hosted/CurrentOrganization",
) {}
export const publishingScope = (slug: string) => `${slug}.${publishingDomain}`;
export const publishingSlug = (scope: string) =>
  scope.endsWith(`.${publishingDomain}`) ? scope.slice(0, -publishingDomain.length - 1) : undefined;

export class CurrentOrganizationNamespace extends Context.Service<
  CurrentOrganizationNamespace,
  Effect.Effect<string, AuthenticationUnavailable | OrganizationForbidden>
>()("hosted/CurrentOrganizationNamespace") {}

export class RequireOrganization extends HttpApiMiddleware.Service<
  RequireOrganization,
  { provides: CurrentOrganization | CurrentOrganizationNamespace }
>()("hosted/RequireOrganization", {
  error: [Unauthorized, Forbidden, AuthenticationUnavailable, OrganizationForbidden],
}) {}

export const organizationOwner = (organization: OrganizationId) =>
  OwnerId.make(`organization:${organization}`);

export const OrganizationIconInvalid = ApiError.define({
  tag: "OrganizationIconInvalid",
  status: 400,
  message: "The organization icon upload is not a supported image within the size limit.",
});
export type OrganizationIconInvalid = typeof OrganizationIconInvalid.Type;
export const OrganizationIconUnavailable = ApiError.define({
  tag: "OrganizationIconUnavailable",
  status: 503,
  message: "Executor's image storage could not complete this request. Try again.",
});
export type OrganizationIconUnavailable = typeof OrganizationIconUnavailable.Type;
export const OrganizationIconNotFound = ApiError.define({
  tag: "OrganizationIconNotFound",
  status: 404,
  message: "This organization has no uploaded icon.",
});
export type OrganizationIconNotFound = typeof OrganizationIconNotFound.Type;
export class OrganizationIcons extends Context.Service<
  OrganizationIcons,
  {
    readonly upload: (
      organization: OrganizationId,
      image: UploadedOrganizationIcon,
    ) => Effect.Effect<{ readonly logo: string }, OrganizationIconUnavailable>;
    readonly read: (
      organization: OrganizationId,
      key: string,
    ) => Effect.Effect<
      { readonly bytes: Uint8Array; readonly contentType: OrganizationIconContentType },
      OrganizationIconUnavailable | OrganizationIconNotFound
    >;
    readonly remove: (
      organization: OrganizationId,
      key: string,
    ) => Effect.Effect<void, OrganizationIconUnavailable>;
  }
>()("hosted/OrganizationIcons") {}

export const Inventory = Schema.Struct({
  links: Schema.Array(Schema.Struct({ app: AppId, account: AccountId })),
  appLinks: Schema.Array(
    Schema.Struct({
      app: AppId,
      requirement: Schema.String,
      account: AccountId,
      provider: ProviderId,
      label: Schema.String,
    }),
  ),
  apps: Schema.Array(App),
  accounts: Schema.Array(
    Schema.Struct({ ...Account.fields, health: Schema.optionalKey(AccountHealth) }),
  ),
  accountSetup: Schema.Struct({ redirectUri: HttpUrl }),
});
export type Inventory = typeof Inventory.Type;
export const HostedOrganization = HttpApiGroup.make("organization")
  .add(
    HttpApiEndpoint.post("uploadIcon", "/api/organizations/:organization/icon", {
      params: { organization: OrganizationReference },
      payload: UploadedOrganizationIcon,
      success: Schema.Struct({ logo: OrganizationIconUrl }),
      error: [OrganizationIconInvalid, OrganizationIconUnavailable, OrganizationForbidden],
    }).middleware(RequireBrowserSession),
  )
  .add(
    HttpApiEndpoint.get("icon", "/api/organizations/:organization/icons/:key", {
      params: { organization: OrganizationReference, key: OrganizationIconKey },
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      error: [OrganizationIconUnavailable, OrganizationIconNotFound],
    }).middleware(RequireBrowserSession),
  )
  .add(
    HttpApiEndpoint.get("catalog", "/api/organizations/:organization/catalog", {
      params: { organization: OrganizationReference },
      query: CatalogQuery,
      success: Schema.Array(CatalogEntry),
      error: CatalogUnavailable,
    })
      .annotate(RequiredAction, "read")
      .annotate(
        OpenApi.Description,
        "List the app catalog: Executor's official apps, each installed with apps.install. On a self-hosted instance, an unfiltered result holding only the Executor app can mean the catalog is turned off. apps.install then asks for an account through the app's own providers. The whole catalog has over a thousand entries, so pass search, and limit, to keep the result small. To add a remote MCP server the catalog does not list, use apps.importCustom; for any other service, write an app with the Executor app's app-authoring skill.",
      ),
  )
  .add(
    HttpApiEndpoint.get("access", "/api/organizations/:organization/access", {
      params: { organization: OrganizationReference },
      success: OrganizationAccess,
    }).annotate(RequiredAction, "discover"),
  )
  .add(
    HttpApiEndpoint.get("inventory", "/api/organizations/:organization/inventory", {
      params: { organization: OrganizationReference },
      success: Inventory,
      error: [StorageError, OrganizationForbidden],
    }).annotate(RequiredAction, "discover"),
  )
  .middleware(RequireOrganization);
