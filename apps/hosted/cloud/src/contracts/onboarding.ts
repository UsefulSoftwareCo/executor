import { RequireUser, OrganizationId, OrganizationLogo } from "@executor-js/hosted-server";
import { ApiError } from "@executor-js/utils/api-error";
import { Context, Effect, Schema } from "effect";
import {
  UploadedOrganizationIcon,
  OrganizationIconKey,
  type OrganizationIconContentType,
} from "@executor-js/hosted-server/organization-icon";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

/** Safe uploader identity for the existing first-team icon namespace. */
export const TeamIconOwner = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,255}$/u));

/** Public company information, cached by verified email domain. */
export const CompanyProfile = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  website: Schema.String,
  description: Schema.NullOr(Schema.String),
  logo: OrganizationLogo,
  colors: Schema.Array(Schema.String),
});
export type CompanyProfile = typeof CompanyProfile.Type;

/** The user confirms the display name; the server derives the URL separately. */
export const TeamName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
  Schema.isPattern(/\S/u),
);
/** Editable values shown before creating the first organization. */
export const TeamDetails = Schema.Struct({ name: TeamName, logo: OrganizationLogo });
export type TeamDetails = typeof TeamDetails.Type;
/** Confirm a suggested URL, no icon, or a selected file; files are stored only on Continue. */
export const CreateTeam = Schema.Struct({
  ...TeamDetails.fields,
  logo: Schema.Union([OrganizationLogo, UploadedOrganizationIcon]),
});
export type CreateTeam = typeof CreateTeam.Type;
/** Invalid or oversized creation payloads are rejected before storage or provisioning. */
export const TeamDetailsInvalid = ApiError.define({
  tag: "TeamDetailsInvalid",
  status: 400,
  message: "The team details are invalid or too large.",
});
export type TeamDetailsInvalid = typeof TeamDetailsInvalid.Type;
/** Missing and inaccessible uploaded icons have the same response. */
export const TeamIconNotFound = ApiError.define({
  tag: "TeamIconNotFound",
  status: 404,
  message: "The uploaded team icon does not exist.",
});
export type TeamIconNotFound = typeof TeamIconNotFound.Type;

/** Existing or newly confirmed memberships reconcile the browser's organization list. */
export const OnboardingReady = Schema.Struct({
  status: Schema.Literal("ready"),
  organizations: Schema.Array(
    Schema.Struct({
      id: OrganizationId,
      name: Schema.String,
      slug: Schema.NonEmptyString,
      logo: Schema.NullOr(Schema.String),
    }),
  ),
});
/** Invitations take priority over first-team creation. */
export const OnboardingInvitation = Schema.Struct({
  status: Schema.Literal("invitation"),
  invitation: Schema.String,
});
/** Preparing suggestions never creates an organization. */
export const OnboardingDraft = Schema.Struct({
  status: Schema.Literal("draft"),
  suggestion: TeamDetails,
});
/** A new account whose email belongs to an Executor v1 organization stays on v1; no team is created. */
export const OnboardingV1Workspace = Schema.Struct({ status: Schema.Literal("v1") });
/** Entry either has a destination or needs explicit team confirmation. */
export const OnboardingEntry = Schema.Union([
  OnboardingReady,
  OnboardingInvitation,
  OnboardingDraft,
  OnboardingV1Workspace,
]);
/** A confirmation can also discover membership, an invitation or a v1 organization. */
export const OnboardingCreated = Schema.Union([
  OnboardingReady,
  OnboardingInvitation,
  OnboardingV1Workspace,
]);

/** Setup failed before a confirmed result; retrying cannot create another organization. */
export const OnboardingUnavailable = ApiError.define({
  tag: "OnboardingUnavailable",
  status: 503,
  message: "Executor could not complete onboarding. Try again.",
});
export type OnboardingUnavailable = typeof OnboardingUnavailable.Type;
/** A company suggestion is optional; a failed lookup never prevents confirmation. */
export class CompanyLookupFailed extends Schema.TaggedError<CompanyLookupFailed>()(
  "CompanyLookupFailed",
  {},
) {}
/** Null means a personal/disposable address or a domain without a company match. */
export class CompanyLookup extends Context.Service<
  CompanyLookup,
  {
    readonly lookup: (domain: string) => Effect.Effect<CompanyProfile | null, CompanyLookupFailed>;
  }
>()("cloud/CompanyLookup") {}

/** The v1 lookup could not answer; entry fails closed and the person can retry. */
export class V1MembershipUnavailable extends Schema.TaggedError<V1MembershipUnavailable>()(
  "V1MembershipUnavailable",
  {},
) {}
/**
 * Decides whether a v2 account with no v2 organization belongs on Executor v1. Callers pass
 * only verified emails. The check is off where v1's WorkOS key is not configured.
 */
export class V1Membership extends Context.Service<
  V1Membership,
  {
    readonly check: (account: {
      readonly email: string;
      readonly createdAt: Date;
    }) => Effect.Effect<"v1" | "continue", V1MembershipUnavailable>;
  }
>()("cloud/V1Membership") {}

/** Cloud entry prepares a suggestion, then provisions only after explicit confirmation. */
export class Onboarding extends Context.Service<
  Onboarding,
  {
    readonly prepare: (
      userId: string,
    ) => Effect.Effect<typeof OnboardingEntry.Type, OnboardingUnavailable>;
    readonly create: (
      userId: string,
      details: CreateTeam,
    ) => Effect.Effect<typeof OnboardingCreated.Type, OnboardingUnavailable>;
    /**
     * Whether this account may create an organization outside team setup, such as through
     * Better Auth's organization endpoint. Applies the same decision as `prepare` and
     * `create`: false only when the account belongs on Executor v1. Fails closed.
     */
    readonly allowsOrganization: (userId: string) => Effect.Effect<boolean, OnboardingUnavailable>;
    readonly icon: (
      userId: string,
      owner: string,
      key: string,
    ) => Effect.Effect<
      { readonly bytes: Uint8Array; readonly contentType: OrganizationIconContentType },
      TeamIconNotFound | OnboardingUnavailable
    >;
  }
>()("cloud/Onboarding") {}

/** Cookie authentication and origin checks apply to suggestion and confirmation requests. */
export const onboardingGroup = HttpApiGroup.make("onboarding")
  .add(
    HttpApiEndpoint.post("prepare", "/api/onboarding/prepare", {
      success: OnboardingEntry,
      error: OnboardingUnavailable,
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/api/onboarding/create", {
      payload: CreateTeam,
      success: OnboardingCreated,
      error: [OnboardingUnavailable, TeamDetailsInvalid],
    }),
  )
  .add(
    HttpApiEndpoint.get("icon", "/api/onboarding/icons/:owner/:key", {
      params: { owner: TeamIconOwner, key: OrganizationIconKey },
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      error: [OnboardingUnavailable, TeamIconNotFound],
    }),
  )
  .middleware(RequireUser);
