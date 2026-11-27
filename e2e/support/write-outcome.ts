import { expect } from "@effect/vitest";

export const unknownOutcomeAction =
  "Do not automatically repeat this call or duplicate its change. Executor could not confirm its outcome.";

export const unknownOutcomeInstructions =
  "This call may have changed data or may still complete. A safe read can show effects but cannot rule out later completion. Tell the user what is known and get their agreement before repeating the change.";

export const unknownOutcomeEnding =
  "Repairing the cause does not establish whether the earlier call completed.";

const notRepeated =
  "Because this call may have changed data, do not repeat it automatically; steps in that advice other than repeating the call still apply.";

const quotation = (advice: string) =>
  `“${advice.replaceAll("“", "‘").replaceAll("”", "’")}” ${notRepeated}`;

export const readAdvice = (advice: string) =>
  `For a call that only reads, the advice for this failure is: ${quotation(advice)}`;

export const declaredAdvice = (advice: string) =>
  `The API’s error response said: ${quotation(advice)}`;

export const unknownOutcomeRecovery = (cause: string) => ({
  action: unknownOutcomeAction,
  instructions: `${unknownOutcomeInstructions} ${cause} ${unknownOutcomeEnding}`,
});

const operative = (text: string) => text.replaceAll(/“[^”]*”/g, "");

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

const ranClaims = /\b(did not run|before it runs|never ran|not sent|nothing (was )?changed)\b/i;

const callAgain =
  /\b(try again|retry|call (it|the tool) again|call it as an? (query|mutation)|run it from)\b/i;

export const expectNoRepeatAdvice = (text: string, label?: string) => {
  expect(text, label).not.toMatch(ranClaims);
  expect(operative(text), label).not.toMatch(callAgain);
};
