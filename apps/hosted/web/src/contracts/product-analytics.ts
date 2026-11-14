/** Explicit browser actions carry only authored labels and outcomes, never form values or URLs. */
import { Effect, Exit, Cause, Schema } from "effect";
import { SetupOrder, SetupSkip } from "@executor-js/hosted-server/setup";
import { AssistantId } from "@executor-js/ui/contracts/dashboard";

const Label = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_.-]{0,79}$/u));

/** The Cloud listener parses the event boundary and discards undeclared fields. */
export const BrowserUsage = Schema.Struct({
  area: Label,
  action: Label,
  outcome: Schema.Literals(["started", "success", "failure", "cancelled", "viewed"]),
  /** The setup order an onboarding step showed, set only for a team in the onboarding experiment. */
  onboarding_variant: Schema.optionalKey(SetupOrder),
  /** Whether its steps could be skipped, set only for a member in the onboarding skip experiment. */
  onboarding_skip_variant: Schema.optionalKey(SetupSkip),
  /** The assistant a setup step's guide is for, on the steps that follow picking one. */
  assistant: Schema.optionalKey(AssistantId),
});
export type BrowserUsage = typeof BrowserUsage.Type;

/**
 * Shared UI can announce actions; only an enabled Cloud host installs a collector. A server render
 * is not a browser action, so reads it performs are not reported.
 */
export const reportBrowserUsage = (usage: BrowserUsage) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("executor:product-usage", { detail: usage }));
};

/** Observe native browser operations which do not pass through the hosted API contract. */
export const observeBrowserUsage = <A, E, R>(
  area: string,
  action: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.sync(() => reportBrowserUsage({ area, action, outcome: "started" })).pipe(
    Effect.andThen(
      effect.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() =>
            reportBrowserUsage({
              area,
              action,
              outcome: Exit.isSuccess(exit)
                ? "success"
                : Cause.hasInterrupts(exit.cause)
                  ? "cancelled"
                  : "failure",
            }),
          ),
        ),
      ),
    ),
  );
