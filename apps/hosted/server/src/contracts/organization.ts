import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { Profile } from "@executor-js/sdk/core";
import { RequiredAction } from "./authorization.ts";
import { CatalogEntry, CatalogUnavailable } from "@executor-js/catalog/contracts";
import { Context, Effect, Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
} from "effect/unstable/httpapi";
import { Account, App, OwnerId, HttpUrl, StorageError } from "@executor-js/sdk/core";
import {
  OrganizationIconUrl,
  OrganizationIconKey,
  UploadedOrganizationIcon,
  type OrganizationIconContentType,
} from "./organization-icon.ts";
import { AuthenticationUnavailable, Forbidden, Unauthorized, RequireUser } from "./auth.ts";

/** Better Auth organization identity; never a caller-selected SDK owner. */
export const OrganizationId = Schema.NonEmptyString.pipe(Schema.brand("OrganizationId"));
export type OrganizationId = typeof OrganizationId.Type;
/** Canonical URL handle, unique across all organizations in this hosted installation. */
export const organizationSlugMaxLength = 45;
/** Team handles leave room for a production wildcard certificate name. */
export const OrganizationSlug = Schema.String.check(
  Schema.isMaxLength(organizationSlugMaxLength),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
).pipe(Schema.brand("OrganizationSlug"));
export type OrganizationSlug = typeof OrganizationSlug.Type;
/** Explicit API target. Resolution rejects collisions between the ID and slug namespaces. */
export const OrganizationReference = Schema.Union([OrganizationId, OrganizationSlug]);
export type OrganizationReference = typeof OrganizationReference.Type;
/** An icon is an HTTPS image, a private uploaded-image path, or null. */
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
/** Only public display and URL fields can be changed through organization settings. */
export const OrganizationDetailsUpdate = Schema.Struct({
  name: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120), Schema.isPattern(/\S/)),
  ),
  slug: Schema.optionalKey(OrganizationSlug),
  logo: Schema.optionalKey(OrganizationLogo),
}).check(
  Schema.makeFilter(
    (data) => data.name !== undefined || data.slug !== undefined || data.logo !== undefined,
  ),
);
/** Roles enabled by this hosted product's Better Auth organization plugin. */
export const OrganizationRole = Schema.Literals(["owner", "admin", "member"]);
/** Membership checked against the requested organization on this request. */
export const OrganizationAccess = Schema.Struct({
  organization: OrganizationId,
  role: OrganizationRole,
  owner: OwnerId,
});
export type OrganizationAccess = typeof OrganizationAccess.Type;
/** No membership exists, or the caller does not have the required role. */
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
/** Parsed OrganizationForbidden failure. */
export type OrganizationForbidden = typeof OrganizationForbidden.Type;
/** Request-local authority, provided by RequireOrganization. */
export class CurrentOrganization extends Context.Service<CurrentOrganization, OrganizationAccess>()(
  "hosted/CurrentOrganization",
) {}
/** Lazy, authenticated publishing handle; routes that do not need it make no slug lookup. */
export class CurrentOrganizationNamespace extends Context.Service<
  CurrentOrganizationNamespace,
  Effect.Effect<string, AuthenticationUnavailable | OrganizationForbidden>
>()("hosted/CurrentOrganizationNamespace") {}

/** Checks login and current membership for the :organization route parameter. */
export class RequireOrganization extends HttpApiMiddleware.Service<
  RequireOrganization,
  { provides: CurrentOrganization | CurrentOrganizationNamespace }
>()("hosted/RequireOrganization", {
  error: [Unauthorized, Forbidden, AuthenticationUnavailable, OrganizationForbidden],
}) {}

/** Product-owned mapping; the core SDK treats the result as an opaque owner. */
export const organizationOwner = (organization: OrganizationId) =>
  OwnerId.make(`organization:${organization}`);

/** Invalid or oversized image input. */
export class OrganizationIconInvalid extends Schema.TaggedError<OrganizationIconInvalid>()(
  "OrganizationIconInvalid",
  {},
  { httpApiStatus: 400 },
) {}
/** The image store could not complete this request. */
export class OrganizationIconUnavailable extends Schema.TaggedError<OrganizationIconUnavailable>()(
  "OrganizationIconUnavailable",
  {},
  { httpApiStatus: 503 },
) {}
/** Missing uploaded image; membership is checked independently before reading. */
export class OrganizationIconNotFound extends Schema.TaggedError<OrganizationIconNotFound>()(
  "OrganizationIconNotFound",
  {},
  { httpApiStatus: 404 },
) {}
/** Each host supplies its own durable binary store; route middleware owns authorization. */
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
    /** Release one stored image. Only the saved icon is addressable; replaced uploads are not indexed. */
    readonly remove: (
      organization: OrganizationId,
      key: string,
    ) => Effect.Effect<void, OrganizationIconUnavailable>;
  }
>()("hosted/OrganizationIcons") {}

/** Organization-owned inventory. Saved credentials never appear in these records. */
export const Inventory = Schema.Struct({
  profiles: Schema.Array(Profile),
  apps: Schema.Array(App),
  accounts: Schema.Array(Account),
  accountSetup: Schema.Struct({ redirectUri: HttpUrl }),
});
export type Inventory = typeof Inventory.Type;
/** Membership and inventory for the explicitly requested organization. */
export const HostedOrganization = HttpApiGroup.make("organization")
  .add(
    HttpApiEndpoint.post("uploadIcon", "/api/organizations/:organization/icon", {
      params: { organization: OrganizationReference },
      payload: UploadedOrganizationIcon,
      success: Schema.Struct({ logo: OrganizationIconUrl }),
      error: [OrganizationIconInvalid, OrganizationIconUnavailable, OrganizationForbidden],
    }).middleware(RequireUser),
  )
  .add(
    HttpApiEndpoint.get("icon", "/api/organizations/:organization/icons/:key", {
      params: { organization: OrganizationReference, key: OrganizationIconKey },
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      error: [OrganizationIconUnavailable, OrganizationIconNotFound],
    }).middleware(RequireUser),
  )
  .add(
    HttpApiEndpoint.get("catalog", "/api/organizations/:organization/catalog", {
      params: { organization: OrganizationReference },
      success: Schema.Array(CatalogEntry),
      error: CatalogUnavailable,
    }).annotate(RequiredAction, "read"),
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
