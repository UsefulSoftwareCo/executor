import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { TestLive, withCase } from "../support/case.ts";
import { Onboarding } from "../support/onboarding.ts";
import {
  answerOnboardingFlag,
  awaitPersonEvents,
  flagEvaluations,
  onboardingActions,
  onboardingFlag,
  onboardingSkipFlag,
  type Captured,
  type OnboardingOrder,
} from "../support/onboarding-experiment.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

/** The onboarding actions setup itself reports; team creation's own run before any assignment. */
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
/** The setup actions the member started, in order. */
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

/**
 * A new member signs in and PostHog assigns `order` and required steps. Setup offers no skip on
 * either step, the dashboard sends them back to their current step until both are done, and then
 * opens. Each experiment's exposure is recorded once, from the one evaluation, and every setup
 * event carries both variants.
 */
const completeRequiredSetup = (order: OnboardingOrder) =>
  Effect.gen(function* () {
    const target = yield* Target;
    expect(target.metadata.mode).toBe("managed");
    const onboarding = yield* Onboarding;
    yield* onboarding.signInByApi;
    const name = yield* onboarding.prepareTeam;
    const userId = yield* onboarding.sessionUserId;
    yield* answerOnboardingFlag(userId, { variant: order, skip: "required" });
    yield* onboarding.requiredSetup(name, order);

    const events = yield* awaitPersonEvents(
      userId,
      (events) =>
        setupEvents(events).some((event) => event.properties.action === "finish_setup") &&
        events.some((event) => event.event === "account_connected") &&
        events.some((event) => event.event === "agent_connected"),
    );
    expect(yield* flagEvaluations(userId)).toBe(1);
    expect(exposures(events, onboardingSkipFlag)).toEqual(["required"]);
    expect(exposures(events, onboardingFlag)).toEqual([order]);
    // Nothing was skipped: each step was continued once it was done.
    expect(started(events)).toEqual(
      order === "assistant_first"
        ? ["continue_assistant", "continue_accounts", "finish_setup"]
        : ["continue_accounts", "continue_assistant", "finish_setup"],
    );
    expect(
      setupEvents(events).map((event) => [
        event.properties.action,
        event.properties.onboarding_skip_variant,
        event.properties.onboarding_variant,
      ]),
    ).toEqual(setupEvents(events).map((event) => [event.properties.action, "required", order]));
  });

layer(TestLive, { excludeTestServices: true })("Cloud onboarding skip experiment", (it) => {
  it.effect(scenarios.onboardingRequiredAccountsFirst.title, (context) =>
    withCase(
      context,
      completeRequiredSetup("accounts_first").pipe(Effect.provide(Onboarding.layer)),
    ),
  );

  it.effect(scenarios.onboardingRequiredAssistantFirst.title, (context) =>
    withCase(
      context,
      completeRequiredSetup("assistant_first").pipe(Effect.provide(Onboarding.layer)),
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
        // The order flag is left out, so the order experiment serves its control untracked.
        yield* answerOnboardingFlag(userId, { skip: "skippable" });
        // Today's setup: each step offers Skip for now, and skipping both opens the dashboard.
        yield* onboarding.confirmTeam(name, "skip", { checkInstall: false });
        // The exposure is sent apart from the setup events, so it is waited for too.
        const events = yield* awaitPersonEvents(
          userId,
          (events) =>
            setupEvents(events).some((event) => event.properties.action === "skip_assistant") &&
            exposures(events, onboardingSkipFlag).length > 0,
        );
        expect(yield* flagEvaluations(userId)).toBe(1);
        expect(exposures(events, onboardingSkipFlag)).toEqual(["skippable"]);
        expect(exposures(events, onboardingFlag)).toEqual([]);
        expect(started(events)).toEqual(["skip_accounts", "skip_assistant"]);
        expect(
          setupEvents(events).map((event) => [
            event.properties.action,
            event.properties.onboarding_skip_variant,
            "onboarding_variant" in event.properties,
          ]),
        ).toEqual(
          setupEvents(events).map((event) => [event.properties.action, "skippable", false]),
        );
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );
});
