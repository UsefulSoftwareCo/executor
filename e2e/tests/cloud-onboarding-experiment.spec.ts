import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { TestLive, withCase } from "../support/case.ts";
import { Onboarding } from "../support/onboarding.ts";
import {
  answerOnboardingFlag,
  awaitPersonEvents,
  flagRequests,
  onboardingActions,
  onboardingOrderFlag,
  onboardingSkipFlag,
  personEvents,
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
]);
const setupEvents = (events: readonly Captured[]) =>
  onboardingActions(events).filter((event) => setupActions.has(String(event.properties.action)));
const screens = (events: readonly Captured[]) => [
  ...new Set(
    setupEvents(events)
      .filter((event) => event.properties.outcome === "viewed")
      .map((event) => String(event.properties.action)),
  ),
];
const started = (events: readonly Captured[]) =>
  setupEvents(events)
    .filter((event) => event.properties.outcome === "started")
    .map((event) => String(event.properties.action));
const orderExposures = (events: readonly Captured[]) =>
  events.filter(
    (event) =>
      event.event === "$feature_flag_called" &&
      event.properties.$feature_flag === onboardingOrderFlag,
  );

const orderNeverAsked = (userId: string) =>
  Effect.gen(function* () {
    expect(yield* flagRequests(userId)).toEqual([[onboardingSkipFlag]]);
    expect(orderExposures(yield* personEvents(userId))).toEqual([]);
  });

layer(TestLive, { excludeTestServices: true })("Cloud onboarding experiment", (it) => {
  it.effect(scenarios.onboardingAssistantFirst.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        expect(target.metadata.mode).toBe("managed");
        const onboarding = yield* Onboarding;
        yield* onboarding.signInByApi;
        const name = yield* onboarding.prepareTeam;
        const userId = yield* onboarding.sessionUserId;
        yield* onboarding.completeSetup(name);

        const events = yield* awaitPersonEvents(
          userId,
          (events) =>
            setupEvents(events).some((event) => event.properties.action === "finish_setup") &&
            events.some((event) => event.event === "agent_connected"),
        );
        yield* orderNeverAsked(userId);
        expect(screens(events)).toEqual([
          "setup_assistant",
          "setup_guide",
          "setup_accounts",
          "setup_prompt",
        ]);
        expect(started(events)).toEqual([
          "skip_assistant",
          "continue_assistant",
          "skip_accounts",
          "finish_setup",
        ]);
        expect(
          setupEvents(events).map((event) => [
            event.properties.action,
            "onboarding_variant" in event.properties,
            event.properties.action === "finish_setup" ? "leaving" : event.properties.page,
          ]),
        ).toEqual(
          setupEvents(events).map((event) => [
            event.properties.action,
            false,
            event.properties.action === "finish_setup" ? "leaving" : "setup",
          ]),
        );
        const guided = new Set([
          "setup_guide",
          "setup_prompt",
          "skip_assistant",
          "continue_assistant",
          "finish_setup",
        ]);
        expect(
          setupEvents(events).map((event) => [event.properties.action, event.properties.assistant]),
        ).toEqual(
          setupEvents(events).map((event) => [
            event.properties.action,
            guided.has(String(event.properties.action)) ? "claude" : undefined,
          ]),
        );
        expect(
          setupEvents(events).filter((event) => event.properties.action === "finish_setup"),
        ).toHaveLength(1);
        expect(
          events
            .filter((event) => event.event === "agent_connected")
            .map((event) => event.properties.grant_kind),
        ).toContain("mcp");
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );

  it.effect(scenarios.onboardingOrderIgnored.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        expect(target.metadata.mode).toBe("managed");
        const onboarding = yield* Onboarding;
        yield* onboarding.signInByApi;
        const name = yield* onboarding.prepareTeam;
        const userId = yield* onboarding.sessionUserId;
        yield* answerOnboardingFlag(userId, { order: "accounts_first" });
        yield* onboarding.confirmTeam(name);
        const events = yield* awaitPersonEvents(userId, (events) =>
          setupEvents(events).some((event) => event.properties.action === "skip_accounts"),
        );
        yield* orderNeverAsked(userId);
        expect(screens(events)).toEqual(["setup_assistant", "setup_accounts"]);
        expect(started(events)).toEqual(["skip_assistant", "skip_accounts"]);
        expect(
          onboardingActions(yield* personEvents(userId)).filter(
            (event) => "onboarding_variant" in event.properties,
          ),
        ).toEqual([]);
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );

  it.effect(scenarios.onboardingExperimentUnavailable.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        expect(target.metadata.mode).toBe("managed");
        const onboarding = yield* Onboarding;
        yield* onboarding.signInByApi;
        const name = yield* onboarding.prepareTeam;
        const userId = yield* onboarding.sessionUserId;
        yield* answerOnboardingFlag(userId, "unavailable");
        yield* onboarding.confirmTeam(name);
        const events = yield* awaitPersonEvents(userId, (events) =>
          setupEvents(events).some((event) => event.properties.action === "skip_accounts"),
        );
        yield* orderNeverAsked(userId);
        expect(screens(events)).toEqual(["setup_assistant", "setup_accounts"]);
        expect(started(events)).toEqual(["skip_assistant", "skip_accounts"]);
        expect(
          setupEvents(events).some(
            (event) =>
              "onboarding_variant" in event.properties ||
              "onboarding_skip_variant" in event.properties,
          ),
        ).toBe(false);
        expect(
          (yield* personEvents(userId)).filter((event) => event.event === "$feature_flag_called"),
        ).toEqual([]);
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );
});
