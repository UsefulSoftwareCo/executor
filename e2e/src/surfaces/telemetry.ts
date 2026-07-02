// Telemetry surface: query the suite's motel OTLP store for the spans the
// target ACTUALLY exported. This is how a scenario asserts the observability
// contract end-to-end — not "did the code create a span object" but "did the
// span leave the server, with the attributes production queries depend on".
// The dangerous regression mode here is silence (an attribute stamped on the
// wrong span, an error riding the success channel): absent data looks exactly
// like health, so the contract has to be pinned where the data is read.
import { Effect, Schedule } from "effect";

/** One exported span, as motel's /api/spans/search returns it. `tags` is the
 *  span's attributes with every value stringified. */
export interface ExportedSpan {
  readonly traceId: string;
  readonly rootOperationName: string;
  readonly span: {
    readonly spanId: string;
    readonly operationName: string;
    readonly status: "ok" | "error";
    readonly durationMs: number;
    readonly tags: Readonly<Record<string, string>>;
  };
}

export interface SpanQuery {
  /** Exact-match attribute filters (motel `attr.<key>=<value>`). */
  readonly attributes?: Readonly<Record<string, string>>;
  readonly operation?: string;
  readonly traceId?: string;
}

export interface TelemetrySurface {
  /** One-shot search against the trace store. */
  readonly searchSpans: (query: SpanQuery) => Effect.Effect<readonly ExportedSpan[], unknown>;
  /** Search until at least one span matches. Exporters batch (the app
   *  flushes ~1s after the request), so arrival is eventually-consistent —
   *  polling IS the contract: "the span reaches the store, soon". */
  readonly expectSpan: (query: SpanQuery) => Effect.Effect<ExportedSpan, unknown>;
}

export const makeTelemetrySurface = (motelUrl: string): TelemetrySurface => {
  const searchSpans = (query: SpanQuery) =>
    Effect.gen(function* () {
      const params = new URLSearchParams({ lookback: "15m", limit: "100" });
      if (query.operation) params.set("operation", query.operation);
      if (query.traceId) params.set("traceId", query.traceId);
      for (const [key, value] of Object.entries(query.attributes ?? {})) {
        params.set(`attr.${key}`, value);
      }
      const response = yield* Effect.promise(() => fetch(`${motelUrl}/api/spans/search?${params}`));
      if (!response.ok) {
        return yield* Effect.fail(
          `motel span search responded ${response.status}: ${yield* Effect.promise(() => response.text())}`,
        );
      }
      const body = (yield* Effect.promise(() => response.json())) as {
        readonly data?: readonly ExportedSpan[];
      };
      return body.data ?? [];
    });

  return {
    searchSpans,
    expectSpan: (query) =>
      searchSpans(query).pipe(
        Effect.filterOrFail(
          (spans) => spans.length > 0,
          () => `no exported span matched ${JSON.stringify(query)}`,
        ),
        Effect.map((spans) => spans[0]!),
        // ~20s ceiling (40 × 500ms): BatchSpanProcessor flushes ~1s after the
        // request and the dev stack drains on waitUntil; slower is a real bug.
        Effect.retry(Schedule.both(Schedule.spaced("500 millis"), Schedule.recurs(40))),
      ),
  };
};
