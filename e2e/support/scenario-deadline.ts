/** When the running scenario's own time-out ends, for a wait that must report before it does. */
import { Context } from "effect";

/**
 * The epoch milliseconds at which Vitest stops the running scenario: when its body started plus
 * its time-out. Undefined outside a case (an interactive session has none), where a wait keeps no
 * deadline of its own beyond the one its caller gives it.
 */
export const ScenarioDeadline = Context.Reference<number | undefined>("e2e/ScenarioDeadline", {
  defaultValue: () => undefined,
});
