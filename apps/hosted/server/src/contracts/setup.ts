import { Schema } from "effect";

/**
 * Whether a new team's setup steps can be skipped. Cloud's onboarding skip experiment assigns one
 * to each member creating their first team through team setup: `required` steps only move on once
 * done, and the dashboard waits until both are. Every other member, and every other host, can skip.
 */
export const SetupSkip = Schema.Literals(["skippable", "required"]);
export type SetupSkip = typeof SetupSkip.Type;

/** The two steps before the first prompt. */
export const SetupStep = Schema.Literals(["accounts", "assistant"]);
export type SetupStep = typeof SetupStep.Type;

/**
 * The order of a new team's setup steps on every host: connect the assistant, then accounts, then
 * the first prompt. Cloud's onboarding order experiment found more teams connect an assistant
 * when it comes first.
 */
export const setupSteps = ["assistant", "accounts"] as const satisfies readonly [
  SetupStep,
  SetupStep,
];
