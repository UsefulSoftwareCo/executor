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
  /**
   * `setup` when the team setup page confirms, which opens the team's setup steps next. Only
   * those teams join the onboarding skip experiment; MCP consent and device approval create a team
   * on the way to their client and omit it.
   */
  next: Schema.optionalKey(Schema.Literal("setup")),
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
/** Entry either has a destination or needs explicit team confirmation. */
export const OnboardingEntry = Schema.Union([
  OnboardingReady,
  OnboardingInvitation,
  OnboardingDraft,
]);

/**
 * The onboarding skip experiment, assigned to members creating their first team through setup:
 * `skippable` (the control) keeps today's "Skip for now", `required` takes it away and keeps the
 * dashboard closed until both steps are done. See `notes/posthog.md#onboarding-skip-experiment`.
 */
export const onboardingSkipExperiment = {
  flag: "onboarding-skip-v1",
  control: "skippable",
  attributionDays: 7,
} as const satisfies { readonly control: SetupSkip } & Record<string, unknown>;

/** Whether this member's setup steps for this team can be skipped, and whether that is tracked. */
export const SetupSkipAssignment = Schema.Struct({ variant: SetupSkip, enrolled: Schema.Boolean });
export type SetupSkipAssignment = typeof SetupSkipAssignment.Type;

/**
 * The setup this member sees for this team: whether its steps can be skipped. `skip.enrolled` marks
 * the member in the skip experiment; every other member, including one whose evaluation failed,
 * sees its control untracked. The steps always run assistant first (`setupSteps`).
 *
 * `order` and `enrolled` are what the ended order experiment answered. This server answers the
 * order that won, untracked; no page reads them. They keep the previous build working across the
 * deploy in both directions: its pages require both, and its API, which this dashboard can meet
 * while the Workers roll out, may still answer an assignment. Remove them in the release that stops
 * declaring the experiment in `alchemy.posthog.ts`.
 */
export const SetupSequence = Schema.Struct({
  order: Schema.Literals(["accounts_first", "assistant_first"]),
  enrolled: Schema.Boolean,
  skip: SetupSkipAssignment,
});
export type SetupSequence = typeof SetupSequence.Type;

/**
 * Whether the team's dashboard is open to this member. It is closed only to a member whose setup
 * is `required` and who has not done both steps; `step` is the first not done. When the assistant
 * is connected, `agent` is the agent it connected, which the account step carries to the first
 * prompt.
 */
export const SetupGate = Schema.Union([
  Schema.Struct({ status: Schema.Literal("open") }),
  Schema.Struct({
    status: Schema.Literal("setup"),
    step: SetupStep,
    agent: Schema.optionalKey(GrantId),
  }),
]);
export type SetupGate = typeof SetupGate.Type;

/**
 * A team created for its setup carries its setup, so its first step opens without reading it
 * again. The setup is left out when it could not be read; the setup layout then reads it.
 */
export const OnboardingTeamCreated = Schema.Struct({
  ...OnboardingReady.fields,
  setup: Schema.optionalKey(SetupSequence),
});
/** A confirmation can also discover membership or an invitation. */
export const OnboardingCreated = Schema.Union([OnboardingTeamCreated, OnboardingInvitation]);

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
     * The setup for a team this member created through team setup. The first read for an enrolled
     * member records the skip experiment's exposure; later reads return the same setup.
     */
    readonly setup: (
      userId: string,
      organization: OrganizationId,
    ) => Effect.Effect<SetupSequence, OnboardingUnavailable>;
    /**
     * Whether the team's dashboard is open to this member. `progress` reads what the member has
     * done of the steps; it runs only for a member whose setup is required and not yet finished.
     * Finding both steps done finishes setup for good.
     */
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
  .middleware(RequireBrowserSession);

/**
 * A new team's setup steps read their setup with the page, and dashboard pages whether setup still
 * holds them; membership is checked first.
 */
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
