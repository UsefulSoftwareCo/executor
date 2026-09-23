/** Shared MCP elicitation data. Delivery belongs to the host, independently of its transport. */
import { Schema, type Effect } from "effect";
import * as McpSchema from "effect/unstable/ai/McpSchema";
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

/** Build the framework's own policy prompt after native input decoding. Includes no account credentials. */
export const approvalElicitation = (toolName: string, input: JsonValue): ApprovalElicitation => ({
  mode: "form",
  message: `Approve ${toolName}?\n\nArguments:\n${JSON.stringify(input, null, 2)}`,
  requestedSchema: { type: "object", properties: {} },
});
