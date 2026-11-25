import {
  RequireBrowserSession,
  OrganizationId,
  OrganizationLogo,
  type SetupProgress,
} from "@executor-js/hosted-server";
import {
  OrganizationReference,
  RequireOrganization,
} from "@executor-js/hosted-server/organization";
import { SetupSkip, SetupStep } from "@executor-js/hosted-server/setup";
import { GrantId } from "@executor-js/mcp-auth/grants";
import { ApiError } from "@executor-js/utils/api-error";
import { Context, Effect, Schema } from "effect";
import {
  UploadedOrganizationIcon,
  OrganizationIconKey,
  type OrganizationIconContentType,
} from "@executor-js/hosted-server/organization-icon";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

export const TeamIconOwner = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,255}$/u));

export const CompanyProfile = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  website: Schema.String,
  description: Schema.NullOr(Schema.String),
  logo: OrganizationLogo,
  colors: Schema.Array(Schema.String),
});
export type CompanyProfile = typeof CompanyProfile.Type;

export const TeamName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
  Schema.isPattern(/\S/u),
);
export const TeamDetails = Schema.Struct({ name: TeamName, logo: OrganizationLogo });
export type TeamDetails = typeof TeamDetails.Type;
export const CreateTeam = Schema.Struct({
  ...TeamDetails.fields,
  logo: Schema.Union([OrganizationLogo, UploadedOrganizationIcon]),
  next: Schema.optionalKey(Schema.Literal("setup")),
});
export type CreateTeam = typeof CreateTeam.Type;
export const TeamDetailsInvalid = ApiError.define({
  tag: "TeamDetailsInvalid",
  status: 400,
  message: "The team details are invalid or too large.",
});
export type TeamDetailsInvalid = typeof TeamDetailsInvalid.Type;
export const TeamIconNotFound = ApiError.define({
  tag: "TeamIconNotFound",
  status: 404,
  message: "The uploaded team icon does not exist.",
});
export type TeamIconNotFound = typeof TeamIconNotFound.Type;

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
export const OnboardingInvitation = Schema.Struct({
  status: Schema.Literal("invitation"),
  invitation: Schema.String,
});
export const OnboardingDraft = Schema.Struct({
  status: Schema.Literal("draft"),
  suggestion: TeamDetails,
});
export const OnboardingEntry = Schema.Union([
  OnboardingReady,
  OnboardingInvitation,
  OnboardingDraft,
]);

export const onboardingSkipExperiment = {
  flag: "onboarding-skip-v1",
  control: "skippable",
  attributionDays: 7,
} as const satisfies { readonly control: SetupSkip } & Record<string, unknown>;

export const SetupSkipAssignment = Schema.Struct({ variant: SetupSkip, enrolled: Schema.Boolean });
export type SetupSkipAssignment = typeof SetupSkipAssignment.Type;

export const SetupSequence = Schema.Struct({
  order: Schema.Literals(["accounts_first", "assistant_first"]),
  enrolled: Schema.Boolean,
  skip: SetupSkipAssignment,
});
export type SetupSequence = typeof SetupSequence.Type;

export const SetupGate = Schema.Union([
  Schema.Struct({ status: Schema.Literal("open") }),
  Schema.Struct({
    status: Schema.Literal("setup"),
    step: SetupStep,
    agent: Schema.optionalKey(GrantId),
  }),
]);
export type SetupGate = typeof SetupGate.Type;

export const OnboardingTeamCreated = Schema.Struct({
  ...OnboardingReady.fields,
  setup: Schema.optionalKey(SetupSequence),
});
export const OnboardingCreated = Schema.Union([OnboardingTeamCreated, OnboardingInvitation]);

export const OnboardingUnavailable = ApiError.define({
  tag: "OnboardingUnavailable",
  status: 503,
  message: "Executor could not complete onboarding. Try again.",
});
export type OnboardingUnavailable = typeof OnboardingUnavailable.Type;
export class CompanyLookupFailed extends Schema.TaggedError<CompanyLookupFailed>()(
  "CompanyLookupFailed",
  {},
) {}
export class CompanyLookup extends Context.Service<
  CompanyLookup,
  {
    readonly lookup: (domain: string) => Effect.Effect<CompanyProfile | null, CompanyLookupFailed>;
  }
>()("cloud/CompanyLookup") {}

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
    readonly setup: (
      userId: string,
      organization: OrganizationId,
    ) => Effect.Effect<SetupSequence, OnboardingUnavailable>;
    readonly gate: <E, R>(
      userId: string,
      organization: OrganizationId,
      progress: Effect.Effect<SetupProgress, E, R>,
    ) => Effect.Effect<SetupGate, OnboardingUnavailable, R>;
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
  .middleware(RequireBrowserSession);

export const setupGroup = HttpApiGroup.make("setup")
  .add(
    HttpApiEndpoint.get("sequence", "/api/organizations/:organization/setup", {
      params: { organization: OrganizationReference },
      success: SetupSequence,
      error: OnboardingUnavailable,
    }),
  )
  .add(
    HttpApiEndpoint.get("gate", "/api/organizations/:organization/setup/gate", {
      params: { organization: OrganizationReference },
      success: SetupGate,
      error: OnboardingUnavailable,
    }),
  )
  .middleware(RequireOrganization)
  .middleware(RequireBrowserSession);
