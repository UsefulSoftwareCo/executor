import { expect } from "@effect/vitest";

/**
 * What an agent is told when Executor could not confirm whether a call that may change data
 * completed: it must not repeat the call automatically.
 */
export const unknownOutcomeAction =
  "Do not automatically repeat this call or duplicate its change. Executor could not confirm its outcome.";

/** The agent instructions that lead such a failure's recovery. */
export const unknownOutcomeInstructions =
  "This call may have changed data or may still complete. A safe read can show effects but cannot rule out later completion. Tell the user what is known and get their agreement before repeating the change.";

/** How such a failure's recovery ends, after the cause's own recovery. */
export const unknownOutcomeEnding =
  "Repairing the cause does not establish whether the earlier call completed.";

const notRepeated =
  "Because this call may have changed data, do not repeat it automatically; steps in that advice other than repeating the call still apply.";

/** Advice quoted as information; quotation marks inside it become single ones. */
const quotation = (advice: string) =>
  `“${advice.replaceAll("“", "‘").replaceAll("”", "’")}” ${notRepeated}`;

/** A cause's recovery written for a read, quoted as advice for a read only. */
export const readAdvice = (advice: string) =>
  `For a call that only reads, the advice for this failure is: ${quotation(advice)}`;

/** Recovery the app's API stated in its error response, quoted as the API's words. */
export const declaredAdvice = (advice: string) =>
  `The API’s error response said: ${quotation(advice)}`;

/** The whole recovery of a failed write whose cause is presented as `cause`. */
export const unknownOutcomeRecovery = (cause: string) => ({
  action: unknownOutcomeAction,
  instructions: `${unknownOutcomeInstructions} ${cause} ${unknownOutcomeEnding}`,
});

/** The text outside quotations, which an agent is meant to act on. */
const operative = (text: string) => text.replaceAll(/“[^”]*”/g, "");

/**
 * Check a failed write's recovery: Executor's instruction comes first, the failure's own recovery
 * follows, and it ends saying a repair does not settle the outcome. Advice to try again appears
 * only inside a quotation, never as a step to take.
 */
export const expectUnknownOutcome = (
  recovery: { readonly action: string; readonly instructions: string } | undefined,
  ownAdvice?: string,
) => {
  expect(recovery?.action).toBe(unknownOutcomeAction);
  const instructions = recovery?.instructions ?? "";
  expect(instructions.startsWith(`${unknownOutcomeInstructions} `)).toBe(true);
  expect(instructions.endsWith(` ${unknownOutcomeEnding}`)).toBe(true);
  expect(operative(instructions)).not.toMatch(/\b(try again|retry)\b/i);
  if (ownAdvice === undefined) return;
  expect(instructions.indexOf(ownAdvice)).toBeGreaterThan(unknownOutcomeInstructions.length);
};

/** Claims about what ran, which nothing a failed write reports may make. */
const ranClaims = /\b(did not run|before it runs|never ran|not sent|nothing (was )?changed)\b/i;

/** Advice to make the call again, which a failed write's copy may contain only inside a quotation. */
const callAgain =
  /\b(try again|retry|call (it|the tool) again|call it as an? (query|mutation)|run it from)\b/i;

/**
 * Check a text a surface shows or records for a failed call that may have written: it claims
 * nothing about what ran, and advises another call only inside a quotation.
 */
export const expectNoRepeatAdvice = (text: string, label?: string) => {
  expect(text, label).not.toMatch(ranClaims);
  expect(operative(text), label).not.toMatch(callAgain);
};
