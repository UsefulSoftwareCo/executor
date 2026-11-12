/** A host's reference for a tool call it recorded, as callers receive it beside a failure. */
import { Schema } from "effect";

/**
 * The host's reference for a tool call it recorded: hosted Executor's `call_` ID, which an
 * organization admin can search for in the tool call log. Opaque to MCP.
 */
export const ToolCallReference = Schema.NonEmptyString.check(Schema.isMaxLength(128));
/** What a call's reference is for, as agents and the people reading their output see it. */
export const callLogNote =
  "Executor's reference for this tool call. Quote it to an organization admin, who can find the call in Executor's tool call log by searching for it.";
/**
 * A failed call's reference, beside its error and never inside it: the tool's or service's own
 * error text is unchanged. Only a host that recorded the call gives one.
 */
export const CallLog = Schema.Struct({
  reference: ToolCallReference,
  note: Schema.String,
});
export type CallLog = typeof CallLog.Type;
