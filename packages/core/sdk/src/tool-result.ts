// ---------------------------------------------------------------------------
// ToolResult — typed value-based discriminated union returned by tool
// handlers and `invokeTool`. Domain success and expected failure both
// resolve through Effect's success channel; only true infra defects use
// the Effect failure channel.
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";

export const ToolErrorSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  details: Schema.optional(Schema.Unknown),
  retryable: Schema.optional(Schema.Boolean),
});

export type ToolError = typeof ToolErrorSchema.Type;

export const ToolHttpMetaSchema = Schema.Struct({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
});

/**
 * Transport metadata for HTTP-backed tools (OpenAPI). Kept beside `data`
 * rather than wrapped around it: `data` stays the upstream payload, while
 * cross-cutting transport facts (pagination Link headers, rate-limit
 * headers) remain reachable for callers that need them.
 */
export type ToolHttpMeta = typeof ToolHttpMetaSchema.Type;

export type ToolResult<T> =
  | { readonly ok: true; readonly data: T; readonly http?: ToolHttpMeta }
  | { readonly ok: false; readonly error: ToolError };

export const ToolResult = {
  ok: <T>(data: T, meta?: { readonly http?: ToolHttpMeta }): ToolResult<T> => ({
    ok: true,
    data,
    ...(meta?.http ? { http: meta.http } : {}),
  }),
  fail: <T = never>(error: ToolError): ToolResult<T> => ({ ok: false, error }),
} as const;

const ToolResultSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    data: Schema.Unknown,
    http: Schema.optional(ToolHttpMetaSchema),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: ToolErrorSchema }),
]);

const isUnknownToolResult = Schema.is(ToolResultSchema);

export const isToolResult = (value: unknown): value is ToolResult<unknown> =>
  isUnknownToolResult(value);

/**
 * Annotate the current span with the outcome of a tool invocation.
 *
 * `ToolResult.fail` rides the Effect *success* channel by design (expected
 * failures are values, not defects), which means the tracer records those
 * spans as healthy. Without this, "user keeps hitting 4xx walls" is invisible
 * to telemetry — the exact class of signal that lets us catch product issues
 * before they're reported. Stamped attributes:
 *
 *   - `executor.tool.outcome`      — "ok" | "fail" (always, on ToolResults)
 *   - `executor.tool.error_code`   — ToolError.code (fail only)
 *   - `executor.tool.error_status` — upstream HTTP status (fail, when present)
 *
 * Codes/statuses are enumerable identifiers, never user content — safe span
 * attributes. Non-ToolResult values (raw success payloads) annotate "ok".
 */
export const annotateToolResultOutcome = (value: unknown): Effect.Effect<void> => {
  if (isToolResult(value) && !value.ok) {
    return Effect.annotateCurrentSpan({
      "executor.tool.outcome": "fail",
      "executor.tool.error_code": value.error.code,
      ...(value.error.status != null ? { "executor.tool.error_status": value.error.status } : {}),
    });
  }
  return Effect.annotateCurrentSpan({ "executor.tool.outcome": "ok" });
};
