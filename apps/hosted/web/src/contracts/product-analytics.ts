import { Effect, Exit, Cause, Schema } from "effect";
import { SetupSkip } from "@executor-js/hosted-server/setup";
import { AssistantId } from "@executor-js/ui/contracts/dashboard";

const Label = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_.-]{0,79}$/u));

export const BrowserUsage = Schema.Struct({
  area: Label,
  action: Label,
  outcome: Schema.Literals(["started", "success", "failure", "cancelled", "viewed"]),
  onboarding_skip_variant: Schema.optionalKey(SetupSkip),
  assistant: Schema.optionalKey(AssistantId),
});
export type BrowserUsage = typeof BrowserUsage.Type;

export const reportBrowserUsage = (usage: BrowserUsage) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("executor:product-usage", { detail: usage }));
};

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
