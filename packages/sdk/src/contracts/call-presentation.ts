/** How the failure of an operation that may have written is recorded and presented. */
import type { ErrorPresentation } from "@executor-js/utils/user-facing-error";
import { Schema } from "effect";

/**
 * Present on the failure of an operation that may change data, such as a mutation or a tool of
 * unknown kind, once the host handed its work to the app's code: it may already have made its
 * change, or may still make it, whatever failed. It is recorded from the host's own facts where the
 * operation's failure is reported, as in `tools.call`, never from what the failure says; without it
 * the operation only read, or failed before the app's code received it.
 */
export const MayHaveWritten = Schema.optional(Schema.Literal(true));

/**
 * Executor's recovery for an operation that may have written before it failed. Executor could not
 * confirm whether it changed data, so it is not repeated automatically.
 */
export const unknownOutcome = {
  action:
    "Do not automatically repeat this call or duplicate its change. Executor could not confirm its outcome.",
  instructions:
    "This call may have changed data or may still complete. A safe read can show effects but cannot rule out later completion. Tell the user what is known and get their agreement before repeating the change.",
};

/**
 * A cause's presentation. `declared` marks a recovery the app's API stated in its error response,
 * which Executor did not write and cannot check. `forWrite` marks a recovery Executor wrote for a
 * call that may have written, which follows the shared instruction unchanged.
 */
export type CausePresentation = ErrorPresentation & {
  readonly declared?: true;
  readonly forWrite?: true;
};

/**
 * Advice quoted as information. Quotation marks inside it become single ones, so it stays one
 * quotation.
 */
const quotation = (advice: string) =>
  `“${advice.replaceAll("“", "‘").replaceAll("”", "’")}” Because this call may have changed data, do not repeat it automatically; steps in that advice other than repeating the call still apply.`;

/**
 * A failure's presentation, led by Executor's recovery when its operation may have written. This
 * is the one place the copy of such a failure is composed: every call failure's recovery, the
 * message of a refusal without a presentation of its own (`refusalMessage`), and each surface that
 * presents a call failure itself (`callFailurePresentation`) pass through it. The cause keeps its
 * own title and description, which state what happened without advising another call or claiming
 * what ran. Its recovery stays operative only when Executor wrote it for a call that may have
 * written (`forWrite`). Any other recovery was written for a call that only reads, or stated by the
 * API, and may advise repeating the call, so it is quoted as information under the instruction not
 * to repeat it. The failure is never offered as a retry.
 */
export const callPresentation =
  <Fields extends { readonly mayHaveWritten?: true | undefined }>(
    present: (fields: Fields) => CausePresentation,
  ) =>
  (fields: Fields): ErrorPresentation => {
    const { declared, forWrite, ...presented } = present(fields);
    if (fields.mayHaveWritten !== true) return presented;
    const advice = `${presented.recovery.action} ${presented.recovery.instructions}`;
    const cause =
      declared === true
        ? `The API’s error response said: ${quotation(advice)}`
        : forWrite === true
          ? advice
          : `For a call that only reads, the advice for this failure is: ${quotation(advice)}`;
    return {
      ...presented,
      recovery: {
        action: unknownOutcome.action,
        instructions: `${unknownOutcome.instructions} ${cause} Repairing the cause does not establish whether the earlier call completed.`,
      },
      retryable: false,
    };
  };
