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
/** The ended order experiment's exposures: the product records none any more. */
const orderExposures = (events: readonly Captured[]) =>
  events.filter(
    (event) =>
      event.event === "$feature_flag_called" &&
      event.properties.$feature_flag === onboardingOrderFlag,
  );

/**
 * The one evaluation for a new member's team asks PostHog for the skip experiment's flag only,
 * never the ended order experiment's, and no exposure of the order flag was sent.
 */
const orderNeverAsked = (userId: string) =>
  Effect.gen(function* () {
    expect(yield* flagRequests(userId)).toEqual([[onboardingSkipFlag]]);
    expect(orderExposures(yield* personEvents(userId))).toEqual([]);
  });

layer(TestLive, { excludeTestServices: true })("Cloud onboarding experiment", (it) => {
  /**
   * The ended experiment's winning order: a new member connects the assistant, then accounts, and
   * reaches the first prompt. No setup event carries an order variant.
   */
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
        // Skip reports skip_ and Next, once the agent connects, continue_. The member skips the
        // waiting guide once and comes back. Managed Cloud's account step stays at Skip.
        expect(started(events)).toEqual([
          "skip_assistant",
          "continue_assistant",
          "skip_accounts",
          "finish_setup",
        ]);
        // No setup event carries an order variant. Each is reported from setup, except Open
        // dashboard, which is reported as the dashboard starts to open and so may already name Apps.
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
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );

  /**
   * PostHog still answers the ended order flag with `accounts_first` for this member, but the
   * product never asks for it: setup opens on the assistant step and no event names the order.
   */
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
        // The assistant step, then the account step, then the dashboard. The install check that
        // runs before the checks below gives an exposure the server might send time to arrive.
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
        // The one order: the assistant, then accounts, then the dashboard.
        // The check below is for an exposure that never arrives, which no wait can confirm, so this
        // keeps the install check that runs before it, as on main.
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
        // Exposures are sent with the request that reads setup; none came for this member.
        expect(
          (yield* personEvents(userId)).filter((event) => event.event === "$feature_flag_called"),
        ).toEqual([]);
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );
});
