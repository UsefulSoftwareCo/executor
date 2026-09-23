import { RequireUser, OrganizationId, OrganizationLogo } from "@executor-js/hosted-server";
import { Context, Effect, Schema } from "effect";
import {
  UploadedOrganizationIcon,
  OrganizationIconKey,
  type OrganizationIconContentType,
} from "@executor-js/hosted-server/organization-icon";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";

/** Safe uploader identity for the existing first-team icon namespace. */
export const TeamIconOwner = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,255}$/));

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
  Schema.isPattern(/\S/),
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
export class TeamDetailsInvalid extends Schema.TaggedError<TeamDetailsInvalid>()(
  "TeamDetailsInvalid",
  {},
  { httpApiStatus: 400 },
) {}
/** Missing and inaccessible uploaded icons have the same response. */
export class TeamIconNotFound extends Schema.TaggedError<TeamIconNotFound>()(
  "TeamIconNotFound",
  {},
  { httpApiStatus: 404 },
) {}

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
/** Entry either has a destination or needs explicit team confirmation. */
export const OnboardingEntry = Schema.Union([
  OnboardingReady,
  OnboardingInvitation,
  OnboardingDraft,
]);
/** A confirmation can also discover membership or an invitation added in another tab. */
export const OnboardingCreated = Schema.Union([OnboardingReady, OnboardingInvitation]);

/** Setup failed before a confirmed result; retrying cannot create another organization. */
export class OnboardingUnavailable extends Schema.TaggedError<OnboardingUnavailable>()(
  "OnboardingUnavailable",
  {},
  { httpApiStatus: 503 },
) {}
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
