import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { TestLive, withCase } from "../support/case.ts";
import { Onboarding } from "../support/onboarding.ts";
import {
  answerOnboardingFlag,
  awaitPersonEvents,
  flagEvaluations,
  onboardingActions,
  onboardingSkipFlag,
  type Captured,
} from "../support/onboarding-experiment.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const setupActions = new Set([
  "setup_accounts",
  "setup_assistant",
  "setup_guide",
  "setup_prompt",
  "skip_accounts",
  "skip_assistant",
  "continue_accounts",
  "continue_assistant",
  "finish_setup",
  "leave_setup",
]);
const setupEvents = (events: readonly Captured[]) =>
  onboardingActions(events).filter((event) => setupActions.has(String(event.properties.action)));
const started = (events: readonly Captured[]) =>
  setupEvents(events)
    .filter((event) => event.properties.outcome === "started")
    .map((event) => String(event.properties.action));
const exposures = (events: readonly Captured[], flag: string) =>
  events
    .filter(
      (event) => event.event === "$feature_flag_called" && event.properties.$feature_flag === flag,
    )
    .map((event) => event.properties.$feature_flag_response);

layer(TestLive, { excludeTestServices: true })("Cloud onboarding skip experiment", (it) => {
  it.effect(scenarios.onboardingRequired.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        expect(target.metadata.mode).toBe("managed");
        const onboarding = yield* Onboarding;
        yield* onboarding.signInByApi;
        const name = yield* onboarding.prepareTeam;
        const userId = yield* onboarding.sessionUserId;
        yield* answerOnboardingFlag(userId, { skip: "required" });
        yield* onboarding.requiredSetup(name);

        const events = yield* awaitPersonEvents(
          userId,
          (events) =>
            setupEvents(events).some((event) => event.properties.action === "finish_setup") &&
            events.some((event) => event.event === "account_connected") &&
            events.some((event) => event.event === "agent_connected"),
        );
        expect(yield* flagEvaluations(userId)).toBe(1);
        expect(exposures(events, onboardingSkipFlag)).toEqual(["required"]);
        expect(started(events)).toEqual([
          "continue_assistant",
          "continue_accounts",
          "finish_setup",
        ]);
        expect(
          setupEvents(events).map((event) => [
            event.properties.action,
            event.properties.onboarding_skip_variant,
          ]),
        ).toEqual(setupEvents(events).map((event) => [event.properties.action, "required"]));
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );

  it.effect(scenarios.onboardingSkippable.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        expect(target.metadata.mode).toBe("managed");
        const onboarding = yield* Onboarding;
        yield* onboarding.signInByApi;
        const name = yield* onboarding.prepareTeam;
        const userId = yield* onboarding.sessionUserId;
        yield* answerOnboardingFlag(userId, { skip: "skippable" });
        yield* onboarding.confirmTeam(name, { checkInstall: false });
        const events = yield* awaitPersonEvents(
          userId,
          (events) =>
            setupEvents(events).some((event) => event.properties.action === "skip_accounts") &&
            exposures(events, onboardingSkipFlag).length > 0,
        );
        expect(yield* flagEvaluations(userId)).toBe(1);
        expect(exposures(events, onboardingSkipFlag)).toEqual(["skippable"]);
        expect(started(events)).toEqual(["skip_assistant", "skip_accounts"]);
        expect(
          setupEvents(events).map((event) => [
            event.properties.action,
            event.properties.onboarding_skip_variant,
          ]),
        ).toEqual(setupEvents(events).map((event) => [event.properties.action, "skippable"]));
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );
});
