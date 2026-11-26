import { Schema } from "effect";

export const SetupSkip = Schema.Literals(["skippable", "required"]);
export type SetupSkip = typeof SetupSkip.Type;

export const SetupStep = Schema.Literals(["accounts", "assistant"]);
export type SetupStep = typeof SetupStep.Type;

export const setupSteps = ["assistant", "accounts"] as const satisfies readonly [
  SetupStep,
  SetupStep,
];
