/** Copy and native flag values for one balanced 2x2 homepage experiment. */
import { Schema } from "effect";
import { tagline, introduction } from "./site-copy.ts";

/** Change the ID whenever copy, eligibility or allocation changes after launch. */
export const heroExperiment = {
  id: "hero-clarity-v1",
  attributionDays: 7,
  cookieDays: 30,
  primaryEvent: "cloud_signup_completed",
} as const;

/** Each wording is independently randomized, with equal traffic per combination. */
export const heroHeadlines = {
  category: tagline,
  outcome: "Build tools once. Use them from every agent.",
} as const;

/** Current homepage introduction used by the control and its native experiment notes. */
export const heroIntroduction = introduction;

/** Keep the existing examples and interactions identical across step variants. */
export const heroSteps = {
  build: {
    first: "Ask your agent to build something useful.",
    second: { before: "Deploy ", emphasis: "your tools", after: " to Executor Cloud." },
    third: { before: "Use them from ", emphasis: "Claude, Codex, and more", after: "." },
  },
} as const;

/** Stable IDs identify both factors; the first combination is the unchanged control. */
export const heroVariants = [
  { flag: "control", id: "category-intent", headline: "category", steps: "intent" },
  { flag: "category-build", id: "category-build", headline: "category", steps: "build" },
  { flag: "outcome-intent", id: "outcome-intent", headline: "outcome", steps: "intent" },
  { flag: "outcome-build", id: "outcome-build", headline: "outcome", steps: "build" },
] as const;
/** A supported pre-rendered combination. */
export type HeroVariant = (typeof heroVariants)[number];
/** Values are assigned by PostHog's multivariate flag, never by application randomness. */
export const HeroFlagValue = Schema.Literals(heroVariants.map((variant) => variant.flag));
/** An evaluated native flag value. */
export type HeroFlagValue = typeof HeroFlagValue.Type;
/** Anonymous PostHog identity shared by the server, browser and signup hook. */
export const HeroVisitor = Schema.String.check(Schema.isUUID());
/** The rendered response's native flag result, used only for browser bootstrapping. */
export const HeroAssignment = Schema.Struct({
  experiment: Schema.Literal(heroExperiment.id),
  visitor: HeroVisitor,
  variant: HeroFlagValue,
});
/** Parsed snapshot of the flag result for one HTML response. */
export type HeroAssignment = typeof HeroAssignment.Type;
/** No identity cookie grants authentication or authorization. */
export const heroVisitorCookie = "executor_visitor";
/** Snapshot cookie; the server never uses its variant to make an assignment. */
export const heroCookieName = "executor_hero";
/** Session-only exclusion while reviewing copy. */
export const heroPreviewCookie = "executor_hero_preview";

const cookieValue = (cookies: string, name: string) => {
  const raw = cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw.slice(name.length + 1));
  } catch {
    return undefined;
  }
};

/** Parse only the anonymous UUID, independent of experiment assignment. */
export const readHeroVisitor = (cookies: string) => {
  const value = cookieValue(cookies, heroVisitorCookie);
  return Schema.is(HeroVisitor)(value) ? value : undefined;
};

/** Reject malformed snapshots before they can bootstrap analytics. */
export const readHeroAssignment = (cookies: string): HeroAssignment | undefined => {
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(HeroAssignment))(
      cookieValue(cookies, heroCookieName),
    );
  } catch {
    return undefined;
  }
};

/** Native exposure properties reflect the flag value rendered in this document. */
export const heroProperties = (assignment: HeroAssignment) => ({
  $feature_flag: heroExperiment.id,
  $feature_flag_response: assignment.variant,
  [`$feature/${heroExperiment.id}`]: assignment.variant,
});

/** Build-time asset location; only declared variants can reach this function. */
export const heroDocument = (variant: HeroVariant) => `/experiments/hero/${variant.id}/index.html`;
