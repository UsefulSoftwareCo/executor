/** Shared MCP elicitation data. Delivery belongs to the host, independently of its transport. */
import { Schema, type Effect } from "effect";
import * as McpSchema from "effect/ai/McpSchema";
import { JsonObject, type JsonValue } from "./schema.ts";

/** Maximum human-input wait, separate from active provider execution time. */
export const ElicitationLimits = Schema.Struct({
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ElicitationLimits = typeof ElicitationLimits.Type;
/** Shared input lifetime for MCP collection and upstream forms. */
export const defaultElicitationLimits = ElicitationLimits.make({ timeoutMs: 15 * 60 * 1000 });

/** Plain-data form request derived from the pinned MCP protocol schema. */
export const FormElicitation = Schema.Struct({
  ...McpSchema.ElicitRequestFormParams.fields,
  mode: Schema.Literal("form"),
  requestedSchema: Schema.toEncoded(McpSchema.ElicitRequestFormParams.fields.requestedSchema),
  _meta: Schema.optional(JsonObject),
});
export type FormElicitation = typeof FormElicitation.Type;

/** MCP accept/decline/cancel response, without imposing a client or transport on app code. */
export const ElicitationResponse = Schema.Union([
  Schema.Struct({ ...McpSchema.ElicitAcceptResult.fields, _meta: Schema.optional(JsonObject) }),
  Schema.Struct({ ...McpSchema.ElicitDeclineResult.fields, _meta: Schema.optional(JsonObject) }),
]);
export type ElicitationResponse = typeof ElicitationResponse.Type;

/** A tool interaction could not be delivered or its request/response was invalid. No private payload is retained. */
export class ElicitationFailed extends Schema.TaggedError<ElicitationFailed>()(
  "ElicitationFailed",
  {
    reason: Schema.Literals([
      "unavailable",
      "transaction",
      "invalid-request",
      "invalid-response",
      "transport",
      "expired",
      "forbidden",
    ]),
  },
) {}

/** Trusted, invocation-owned delivery. The signal expires with the tool invocation. */
export type ElicitationHandler = (
  request: FormElicitation,
  signal: AbortSignal,
) => Effect.Effect<ElicitationResponse, ElicitationFailed>;

/** App authors await standard MCP form responses without depending on Effect or a particular host. */
export type Elicit = (request: FormElicitation) => Promise<ElicitationResponse>;

/** Safe reply for a runtime that crosses an RPC boundary. */
export const ElicitationReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), response: ElicitationResponse }),
  Schema.Struct({ ok: Schema.Literal(false), error: ElicitationFailed }),
]);
export type ElicitationReply = typeof ElicitationReply.Type;

/** Invocation consent requests no additional fields; arguments are reviewed, never edited in the form. */
export const ApprovalElicitation = Schema.Struct({
  ...FormElicitation.fields,
  requestedSchema: Schema.Struct({
    type: Schema.Literal("object"),
    properties: Schema.Record(Schema.String, Schema.Never),
  }),
});
export type ApprovalElicitation = typeof ApprovalElicitation.Type;

/** Only empty form content can answer invocation consent. Extra fields cannot change approved arguments. */
export const ApprovalResponse = ElicitationResponse.check(
  Schema.makeFilter(
    (response) =>
      response.action !== "accept" ||
      response.content === undefined ||
      Object.keys(response.content).length === 0,
  ),
);
export type ApprovalResponse = typeof ApprovalResponse.Type;

/**
 * UTF-16 code units of pretty-printed arguments the saved consent prompt shows. Arguments within it
 * are shown exactly; longer ones are shortened, so a pending request holds the arguments once and
 * stays small however large the call. The saved call keeps the exact arguments, and surfaces with
 * room for them show those instead; see `exactApprovalElicitation`.
 */
export const approvalPreviewChars = 4_000;
/** A shortened string keeps at least this many code units, so long values stay recognizable. */
const shortestKept = 32;

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;
/** The first `length` code units of `text`, never ending on the first half of a surrogate pair. */
const prefix = (text: string, length: number) =>
  text.slice(0, isHigh(text.charCodeAt(length - 1)) ? length - 1 : length);
const isArray = (value: Schema.JsonArray | Schema.JsonObject): value is Schema.JsonArray =>
  Array.isArray(value);
/** Characters in `text` as a person counts them: a surrogate pair is one. */
const characters = (text: string) => {
  let pairs = 0;
  for (let index = 1; index < text.length; index += 1)
    if (isLow(text.charCodeAt(index)) && isHigh(text.charCodeAt(index - 1))) pairs += 1;
  return text.length - pairs;
};

/** Text written so far and the code units it may still use; `room` below zero means it overflowed. */
type Output = { readonly parts: string[]; room: number };
const emit = (output: Output, text: string) => {
  output.parts.push(text);
  output.room -= text.length;
};

/**
 * Write `value` as `JSON.stringify(value, null, 2)` does, shortening strings longer than `keep`
 * code units. Writing stops once the output overflows its room, so the work is bounded by the room
 * however large or deeply nested the value is.
 */
const write = (value: JsonValue, keep: number, indent: string, output: Output): void => {
  if (typeof value === "string") {
    if (value.length > keep)
      emit(output, `${JSON.stringify(prefix(value, keep))}… (${characters(value)} characters)`);
    // A string's JSON is never shorter than the string, so encode only the part that can be shown.
    else
      emit(
        output,
        JSON.stringify(value.length > output.room ? prefix(value, output.room + 1) : value),
      );
    return;
  }
  if (typeof value !== "object" || value === null) return emit(output, JSON.stringify(value));
  const inner = `${indent}  `;
  // Each item continues only while there is room, so a huge array or object is not walked.
  const member = (index: number, key: string | undefined, entry: JsonValue) => {
    emit(
      output,
      `${index === 0 ? "" : ","}\n${inner}${key === undefined ? "" : `${JSON.stringify(key)}: `}`,
    );
    if (output.room >= 0) write(entry, keep, inner, output);
    return output.room >= 0;
  };
  if (isArray(value)) {
    if (value.length === 0) return emit(output, "[]");
    emit(output, "[");
    value.every((entry, index) => member(index, undefined, entry));
    return emit(output, `\n${indent}]`);
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return emit(output, "{}");
  emit(output, "{");
  entries.every(([key, entry], index) => member(index, key, entry));
  emit(output, `\n${indent}}`);
};

/** `value` pretty-printed within `room` code units, and whether it fit. */
const printed = (value: JsonValue, keep: number, room: number) => {
  const output: Output = { parts: [], room };
  write(value, keep, "", output);
  return { text: output.parts.join(""), fits: output.room >= 0 };
};

/** Arguments shortened to fit `approvalPreviewChars`; a structure too wide even then is cut. */
const shortened = (input: JsonValue) => {
  let keep = approvalPreviewChars / 2;
  let shown = printed(input, keep, approvalPreviewChars);
  while (!shown.fits && keep > shortestKept) {
    keep = Math.max(shortestKept, Math.floor(keep / 2));
    shown = printed(input, keep, approvalPreviewChars);
  }
  return shown.fits
    ? shown.text
    : `${prefix(shown.text, approvalPreviewChars)}\n… (the rest is not shown)`;
};

/** The policy prompt naming the tool and showing its arguments as `shown`. */
const consent = (toolName: string, shown: string): ApprovalElicitation => ({
  mode: "form",
  message: `Approve ${toolName}?\n\n${shown}`,
  requestedSchema: { type: "object", properties: {} },
});

/**
 * The policy prompt with the exact arguments, or undefined when their pretty-printed JSON is longer
 * than `maxChars` code units. Its work stops at that bound. Includes no account credentials.
 */
export const exactApprovalElicitation = (
  toolName: string,
  input: JsonValue,
  maxChars: number,
): ApprovalElicitation | undefined => {
  const exact = printed(input, Number.POSITIVE_INFINITY, maxChars);
  return exact.fits ? consent(toolName, `Arguments:\n${exact.text}`) : undefined;
};

/**
 * The policy prompt saved with a pending call: the exact arguments when they fit
 * `approvalPreviewChars`, otherwise long strings shortened with their length stated. Hosts build it
 * from the call they saved, so it always describes the exact call approval runs.
 */
export const approvalElicitation = (toolName: string, input: JsonValue): ApprovalElicitation => {
  const exact = exactApprovalElicitation(toolName, input, approvalPreviewChars);
  if (exact !== undefined) return exact;
  return consent(
    toolName,
    `Arguments, shortened for review. Approving runs the call with the complete arguments:\n${shortened(input)}`,
  );
};
