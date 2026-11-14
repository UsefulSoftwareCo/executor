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
  personEvents,
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
]);
const setupEvents = (events: readonly Captured[]) =>
  onboardingActions(events).filter((event) => setupActions.has(String(event.properties.action)));
/** Each setup screen's first view, in the order the member saw them. */
const screens = (events: readonly Captured[]) => [
  ...new Set(
    setupEvents(events)
      .filter((event) => event.properties.outcome === "viewed")
      .map((event) => String(event.properties.action)),
  ),
];
/**
 * The setup actions the member started, in order. A step's forward button reports `skip_` while it
 * reads "Skip for now" and `continue_` once the step is done.
 */
const started = (events: readonly Captured[]) =>
  setupEvents(events)
    .filter((event) => event.properties.outcome === "started")
    .map((event) => String(event.properties.action));
const exposures = (events: readonly Captured[]) =>
  events.filter(
    (event) =>
      event.event === "$feature_flag_called" && event.properties.$feature_flag === onboardingFlag,
  );

/**
 * A new member signs in, PostHog assigns `order`, and they complete setup in that order. The
 * exposure is recorded once with the assigned variant, however often setup is read again, and
 * every setup event carries it.
 */
const completeAssignedOrder = (order: OnboardingOrder) =>
  Effect.gen(function* () {
    const target = yield* Target;
    expect(target.metadata.mode).toBe("managed");
    const onboarding = yield* Onboarding;
    yield* onboarding.signInByApi;
    const name = yield* onboarding.prepareTeam;
    const userId = yield* onboarding.sessionUserId;
    yield* answerOnboardingFlag(userId, { variant: order });
    yield* onboarding.setupInOrder(name, order);

    const events = yield* awaitPersonEvents(
      userId,
      (events) =>
        setupEvents(events).some((event) => event.properties.action === "finish_setup") &&
        events.some((event) => event.event === "agent_connected"),
    );
    expect(yield* flagEvaluations(userId)).toBe(1);
    expect(exposures(events).map((event) => event.properties)).toEqual([
      expect.objectContaining({ $feature_flag: onboardingFlag, $feature_flag_response: order }),
    ]);
    expect(screens(events)).toEqual(
      order === "assistant_first"
        ? ["setup_assistant", "setup_guide", "setup_accounts", "setup_prompt"]
        : ["setup_accounts", "setup_assistant", "setup_guide", "setup_prompt"],
    );
    // Skip reports skip_ and Next, once the agent connects, continue_. The assistant-first member
    // skips the waiting guide once and comes back. Managed Cloud's account step stays at Skip.
    expect(started(events)).toEqual(
      order === "assistant_first"
        ? ["skip_assistant", "continue_assistant", "skip_accounts", "finish_setup"]
        : ["skip_accounts", "continue_assistant", "finish_setup"],
    );
    // Every setup event carries the variant. Each is reported from setup, except Open dashboard,
    // which is reported as the dashboard starts to open and so may already name Apps.
    expect(
      setupEvents(events).map((event) => [
        event.properties.action,
        event.properties.onboarding_variant,
        event.properties.action === "finish_setup" ? "leaving" : event.properties.page,
      ]),
    ).toEqual(
      setupEvents(events).map((event) => [
        event.properties.action,
        order,
        event.properties.action === "finish_setup" ? "leaving" : "setup",
      ]),
    );
    // Events from Claude's guide onward name it; the choices and the account step name none.
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
  });

layer(TestLive, { excludeTestServices: true })("Cloud onboarding experiment", (it) => {
  it.effect(scenarios.onboardingAssistantFirst.title, (context) =>
    withCase(
      context,
      completeAssignedOrder("assistant_first").pipe(Effect.provide(Onboarding.layer)),
    ),
  );

  it.effect(scenarios.onboardingAccountsFirst.title, (context) =>
    withCase(
      context,
      completeAssignedOrder("accounts_first").pipe(Effect.provide(Onboarding.layer)),
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
        // Today's order: accounts first, then the assistant, then the dashboard.
        // The check below is for an exposure that never arrives, which no wait can confirm, so this
        // keeps the install check that runs before it, as on main.
        yield* onboarding.confirmTeam(name, "skip");
        const events = yield* awaitPersonEvents(userId, (events) =>
          setupEvents(events).some((event) => event.properties.action === "skip_assistant"),
        );
        expect(yield* flagEvaluations(userId)).toBe(1);
        expect(screens(events)).toEqual(["setup_accounts", "setup_assistant"]);
        expect(started(events)).toEqual(["skip_accounts", "skip_assistant"]);
        expect(setupEvents(events).some((event) => "onboarding_variant" in event.properties)).toBe(
          false,
        );
        // Exposures are sent with the request that reads setup; none came for this member.
        expect(exposures(yield* personEvents(userId))).toEqual([]);
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );
});
