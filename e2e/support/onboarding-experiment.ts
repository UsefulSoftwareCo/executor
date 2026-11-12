/**
 * Cloud's onboarding experiment through the managed loopback collector: answer one person's flag
 * evaluations, and read the events and evaluations the collector received for them.
 */
import { Effect, FileSystem, Schedule } from "effect";
import { analyticsEvents, type AnalyticsEvent } from "./collector-events.ts";
import { Target } from "./platform.ts";

export const onboardingFlag = "onboarding-order-v1";
export type OnboardingOrder = "accounts_first" | "assistant_first";
export const onboardingSkipFlag = "onboarding-skip-v1";
export type OnboardingSkip = "skippable" | "required";

/**
 * What PostHog answers this person's flag evaluations with: a variant of each onboarding
 * experiment named, or an unavailable service. A flag left out is not in the answer, so its
 * experiment serves its control. The collector answers everyone else with no flags.
 */
export const answerOnboardingFlag = (
  userId: string,
  answer: { readonly variant?: OnboardingOrder; readonly skip?: OnboardingSkip } | "unavailable",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const target = yield* Target;
    const flag = (key: string, variant: string) => ({
      [key]: { key, enabled: true, variant, reason: { code: "condition_match" } },
    });
    const stub =
      answer === "unavailable"
        ? { status: 503, body: { type: "server_error" } }
        : {
            status: 200,
            body: {
              flags: {
                ...(answer.variant === undefined ? {} : flag(onboardingFlag, answer.variant)),
                ...(answer.skip === undefined ? {} : flag(onboardingSkipFlag, answer.skip)),
              },
              errorsWhileComputingFlags: false,
            },
          };
    yield* fs.writeFileString(
      `${target.directory}/flags/${encodeURIComponent(userId)}.json`,
      JSON.stringify(stub),
      { mode: 0o600 },
    );
  });

export type Captured = AnalyticsEvent;

/** Every event the collector received for this person, in delivery order. */
export const personEvents = (userId: string) => analyticsEvents({ person: userId });

/** This person's events once `ready` holds; the server flushes per request, the browser at once. */
export const awaitPersonEvents = (
  userId: string,
  ready: (events: readonly Captured[]) => boolean,
) =>
  personEvents(userId).pipe(
    Effect.repeat({ schedule: Schedule.spaced("200 millis"), until: ready }),
    Effect.timeout("15 seconds"),
  );

/** How many times the Worker asked PostHog for this person's flags. */
export { flagEvaluations } from "./collector-events.ts";

/** The onboarding `product_action` events this person's setup reported, in order. */
export const onboardingActions = (events: readonly Captured[]) =>
  events.filter(
    (event) => event.event === "product_action" && event.properties.area === "onboarding",
  );
