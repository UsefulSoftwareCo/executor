// ---------------------------------------------------------------------------
// ToolResult — typed value-based discriminated union returned by tool
// handlers and `invokeTool`. Domain success and expected failure both
// resolve through Effect's success channel; only true infra defects use
// the Effect failure channel.
// ---------------------------------------------------------------------------

import { Schema } from "effect";

export const ToolErrorSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  details: Schema.optional(Schema.Unknown),
  retryable: Schema.optional(Schema.Boolean),
});

export type ToolError = typeof ToolErrorSchema.Type;

export type ToolResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ToolError };

export const ToolResult = {
  ok: <T>(data: T): ToolResult<T> => ({ ok: true, data }),
  fail: <T = never>(error: ToolError): ToolResult<T> => ({ ok: false, error }),
} as const;

const ToolResultSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), data: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), error: ToolErrorSchema }),
]);

const isUnknownToolResult = Schema.is(ToolResultSchema);

export const isToolResult = (value: unknown): value is ToolResult<unknown> =>
  isUnknownToolResult(value);
