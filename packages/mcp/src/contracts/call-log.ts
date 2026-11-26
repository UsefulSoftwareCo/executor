import { Schema } from "effect";

export const ToolCallReference = Schema.NonEmptyString.check(Schema.isMaxLength(128));
export const callLogNote =
  "Executor's reference for this tool call. Quote it to an organization admin, who can find the call in Executor's tool call log by searching for it.";
export const CallLog = Schema.Struct({
  reference: ToolCallReference,
  note: Schema.String,
});
export type CallLog = typeof CallLog.Type;
