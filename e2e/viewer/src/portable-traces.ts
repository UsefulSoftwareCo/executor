export interface PortableSpanEvent {
  readonly name: string;
  readonly timestamp: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface PortableTraceSpan {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly serviceName: string;
  readonly scopeName: string | null;
  readonly kind: string | null;
  readonly operationName: string;
  readonly startTime: string;
  readonly isRunning: boolean;
  readonly durationMs: number;
  readonly status: "ok" | "error";
  readonly depth: number;
  readonly tags: Readonly<Record<string, string>>;
  readonly warnings: ReadonlyArray<string>;
  readonly events: ReadonlyArray<PortableSpanEvent>;
}

export interface PortableTrace {
  readonly traceId: string;
  readonly serviceName: string;
  readonly rootOperationName: string;
  readonly startedAt: string;
  readonly isRunning: boolean;
  readonly durationMs: number;
  readonly spanCount: number;
  readonly errorCount: number;
  readonly warnings: ReadonlyArray<string>;
  readonly spans: ReadonlyArray<PortableTraceSpan>;
}

export interface PortableTraceExport {
  readonly schemaVersion: 1;
  readonly exportedAt: number;
  readonly traces: ReadonlyArray<{ readonly traceId: string; readonly data: PortableTrace }>;
  readonly missing: ReadonlyArray<{ readonly traceId: string; readonly error: string }>;
  readonly invalidTraceIds: ReadonlyArray<string>;
}

export interface WaterfallPosition {
  readonly left: number;
  readonly width: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const number = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const boolean = (value: unknown): boolean => value === true;

const nullableText = (value: unknown): string | null =>
  value === null ? null : typeof value === "string" ? value : null;

const textArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const textRecord = (value: unknown): Record<string, string> => {
  if (!record(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
};

const eventFrom = (value: unknown): PortableSpanEvent | undefined => {
  if (!record(value) || typeof value.name !== "string") return undefined;
  return {
    name: value.name,
    timestamp: text(value.timestamp),
    attributes: textRecord(value.attributes),
  };
};

const spanFrom = (value: unknown): PortableTraceSpan | undefined => {
  if (!record(value) || typeof value.spanId !== "string") return undefined;
  return {
    spanId: value.spanId,
    parentSpanId: nullableText(value.parentSpanId),
    serviceName: text(value.serviceName, "unknown service"),
    scopeName: nullableText(value.scopeName),
    kind: nullableText(value.kind),
    operationName: text(value.operationName, "unnamed span"),
    startTime: text(value.startTime),
    isRunning: boolean(value.isRunning),
    durationMs: Math.max(0, number(value.durationMs)),
    status: value.status === "error" ? "error" : "ok",
    depth: Math.max(0, Math.floor(number(value.depth))),
    tags: textRecord(value.tags),
    warnings: textArray(value.warnings),
    events: Array.isArray(value.events)
      ? value.events.flatMap((entry) => {
          const event = eventFrom(entry);
          return event ? [event] : [];
        })
      : [],
  };
};

const traceFrom = (value: unknown): PortableTrace | undefined => {
  if (!record(value) || typeof value.traceId !== "string" || !Array.isArray(value.spans)) {
    return undefined;
  }
  const spans = value.spans.flatMap((entry) => {
    const span = spanFrom(entry);
    return span ? [span] : [];
  });
  return {
    traceId: value.traceId,
    serviceName: text(value.serviceName, "unknown service"),
    rootOperationName: text(value.rootOperationName, "unnamed trace"),
    startedAt: text(value.startedAt),
    isRunning: boolean(value.isRunning),
    durationMs: Math.max(0, number(value.durationMs)),
    spanCount: Math.max(spans.length, Math.floor(number(value.spanCount, spans.length))),
    errorCount: Math.max(0, Math.floor(number(value.errorCount))),
    warnings: textArray(value.warnings),
    spans,
  };
};

export const parsePortableTraceExport = (value: unknown): PortableTraceExport | null => {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.traces)) return null;
  const traces = value.traces.flatMap((entry) => {
    if (!record(entry) || typeof entry.traceId !== "string") return [];
    const data = traceFrom(entry.data);
    return data ? [{ traceId: entry.traceId, data }] : [];
  });
  const missing = Array.isArray(value.missing)
    ? value.missing.flatMap((entry) =>
        record(entry) && typeof entry.traceId === "string"
          ? [{ traceId: entry.traceId, error: text(entry.error, "trace unavailable") }]
          : [],
      )
    : [];
  return {
    schemaVersion: 1,
    exportedAt: number(value.exportedAt),
    traces,
    missing,
    invalidTraceIds: textArray(value.invalidTraceIds),
  };
};

export const waterfallPosition = (
  trace: PortableTrace,
  span: PortableTraceSpan,
): WaterfallPosition => {
  const traceStart = Date.parse(trace.startedAt);
  const spanStart = Date.parse(span.startTime);
  const duration = Math.max(trace.durationMs, 0);
  if (!Number.isFinite(traceStart) || !Number.isFinite(spanStart) || duration === 0) {
    return { left: 0, width: 100 };
  }
  const left = Math.min(99.4, Math.max(0, ((spanStart - traceStart) / duration) * 100));
  const available = Math.max(0, 100 - left);
  const width = Math.min(available, Math.max(0.6, (span.durationMs / duration) * 100));
  return { left, width };
};

/** Optional live enhancement. Portable traces remain the primary evidence. */
export const liveMotelViewerFromSearch = (search: string): string | undefined => {
  const candidate = new URLSearchParams(search).get("motel");
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    const loopback =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
};

export const formatTraceDuration = (durationMs: number): string => {
  if (durationMs >= 1_000) return `${(durationMs / 1_000).toFixed(2)}s`;
  if (durationMs >= 1) return `${durationMs.toFixed(durationMs < 10 ? 1 : 0)}ms`;
  return `${Math.round(durationMs * 1_000)}µs`;
};
