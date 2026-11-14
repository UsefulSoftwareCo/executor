import { Schema } from "effect";

/**
 * The order of a new team's setup steps before its first prompt. Cloud's onboarding experiment
 * assigns one to each team created through team setup; every other team, and every other host,
 * connects accounts first.
 */
export const SetupOrder = Schema.Literals(["accounts_first", "assistant_first"]);
export type SetupOrder = typeof SetupOrder.Type;

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
