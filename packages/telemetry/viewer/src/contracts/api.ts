/**
 * The collector routes the viewer reads, with the response shapes Motel returns at the revision
 * pinned in `packages/telemetry/motel/source.json` (its `src/domain.ts` and `src/httpApi.ts`).
 * The collector that replaces Motel returns the same shapes, so this schema serves both.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

const StringRecord = Schema.Record(Schema.String, Schema.String);

export const TraceSpanStatus = Schema.Literals(["ok", "error"]);
export type TraceSpanStatus = typeof TraceSpanStatus.Type;

export const TraceSpanEvent = Schema.Struct({
  name: Schema.String,
  timestamp: Schema.DateFromString,
  attributes: StringRecord,
});
export type TraceSpanEvent = typeof TraceSpanEvent.Type;

export const TraceSpanItem = Schema.Struct({
  spanId: Schema.String,
  parentSpanId: Schema.NullOr(Schema.String),
  serviceName: Schema.String,
  scopeName: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.String),
  operationName: Schema.String,
  startTime: Schema.DateFromString,
  isRunning: Schema.Boolean,
  durationMs: Schema.Number,
  status: TraceSpanStatus,
  depth: Schema.Number,
  tags: StringRecord,
  warnings: Schema.Array(Schema.String),
  events: Schema.Array(TraceSpanEvent),
});
export type TraceSpanItem = typeof TraceSpanItem.Type;

export const TraceItem = Schema.Struct({
  traceId: Schema.String,
  serviceName: Schema.String,
  rootOperationName: Schema.String,
  startedAt: Schema.DateFromString,
  isRunning: Schema.Boolean,
  durationMs: Schema.Number,
  spanCount: Schema.Number,
  errorCount: Schema.Number,
  warnings: Schema.Array(Schema.String),
  spans: Schema.Array(TraceSpanItem),
});
export type TraceItem = typeof TraceItem.Type;

export const TraceSummaryItem = Schema.Struct({
  traceId: Schema.String,
  serviceName: Schema.String,
  rootOperationName: Schema.String,
  startedAt: Schema.DateFromString,
  isRunning: Schema.Boolean,
  durationMs: Schema.Number,
  spanCount: Schema.Number,
  errorCount: Schema.Number,
  warnings: Schema.Array(Schema.String),
});
export type TraceSummaryItem = typeof TraceSummaryItem.Type;

export const LogItem = Schema.Struct({
  id: Schema.String,
  timestamp: Schema.DateFromString,
  serviceName: Schema.String,
  severityText: Schema.String,
  body: Schema.String,
  traceId: Schema.NullOr(Schema.String),
  spanId: Schema.NullOr(Schema.String),
  scopeName: Schema.NullOr(Schema.String),
  attributes: StringRecord,
});
export type LogItem = typeof LogItem.Type;

const ListMeta = Schema.Struct({
  limit: Schema.Number,
  lookback: Schema.String,
  returned: Schema.Number,
  truncated: Schema.Boolean,
  nextCursor: Schema.NullOr(Schema.String),
});

const NotFound = Schema.Struct({ error: Schema.String }).pipe(HttpApiSchema.status(404));

const Lookback = Schema.optionalKey(Schema.String);
const Limit = Schema.optionalKey(Schema.Number);
const Cursor = Schema.optionalKey(Schema.String);
const Service = Schema.optionalKey(Schema.String);

export const TelemetryApi = HttpApi.make("CollectorTelemetry").add(
  HttpApiGroup.make("telemetry").add(
    HttpApiEndpoint.get("services", "/api/services", {
      success: Schema.Struct({ data: Schema.Array(Schema.String) }),
    }),
    HttpApiEndpoint.get("traces", "/api/traces", {
      query: { service: Service, limit: Limit, lookback: Lookback, cursor: Cursor },
      success: Schema.Struct({ data: Schema.Array(TraceSummaryItem), meta: ListMeta }),
    }),
    HttpApiEndpoint.get("trace", "/api/traces/:traceId", {
      params: { traceId: Schema.String },
      success: Schema.Struct({ data: TraceItem }),
      error: NotFound,
    }),
    HttpApiEndpoint.get("traceLogs", "/api/traces/:traceId/logs", {
      params: { traceId: Schema.String },
      query: { lookback: Lookback, limit: Limit, cursor: Cursor },
      success: Schema.Struct({ data: Schema.Array(LogItem), meta: ListMeta }),
    }),
    HttpApiEndpoint.get("logs", "/api/logs", {
      query: {
        service: Service,
        severity: Schema.optionalKey(Schema.String),
        traceId: Schema.optionalKey(Schema.String),
        spanId: Schema.optionalKey(Schema.String),
        body: Schema.optionalKey(Schema.String),
        lookback: Lookback,
        limit: Limit,
        cursor: Cursor,
      },
      success: Schema.Struct({ data: Schema.Array(LogItem), meta: ListMeta }),
    }),
  ),
);
