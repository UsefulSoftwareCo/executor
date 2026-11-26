import { Effect, FileSystem, Schedule } from "effect";
import { analyticsEvents, type AnalyticsEvent } from "./collector-events.ts";
import { Target } from "./platform.ts";

export const onboardingOrderFlag = "onboarding-order-v1";
export type OnboardingOrder = "accounts_first" | "assistant_first";
export const onboardingSkipFlag = "onboarding-skip-v1";
export type OnboardingSkip = "skippable" | "required";

export const answerOnboardingFlag = (
  userId: string,
  answer: { readonly order?: OnboardingOrder; readonly skip?: OnboardingSkip } | "unavailable",
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
                ...(answer.order === undefined ? {} : flag(onboardingOrderFlag, answer.order)),
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

export const personEvents = (userId: string) => analyticsEvents({ person: userId });

export const awaitPersonEvents = (
  userId: string,
  ready: (events: readonly Captured[]) => boolean,
) =>
  personEvents(userId).pipe(
    Effect.repeat({ schedule: Schedule.spaced("200 millis"), until: ready }),
    Effect.timeout("15 seconds"),
  );

export { flagEvaluations, flagRequests } from "./collector-events.ts";

export const onboardingActions = (events: readonly Captured[]) =>
  events.filter(
    (event) => event.event === "product_action" && event.properties.area === "onboarding",
  );
