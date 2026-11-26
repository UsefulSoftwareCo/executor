import { Context } from "effect";

export const ScenarioDeadline = Context.Reference<number | undefined>("e2e/ScenarioDeadline", {
  defaultValue: () => undefined,
});
