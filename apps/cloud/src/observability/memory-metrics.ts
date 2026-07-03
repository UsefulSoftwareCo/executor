import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

const LOG_PREFIX = "[executor:mem-metrics]";
const PERIODIC_EMIT_INTERVAL_MS = 60_000;
const STALLED_WRITE_MS = 30_000;
const EXPORT_SUCCESS_CODE = 0;
export const OTEL_MAX_SPAN_QUEUE_SIZE = 2_048;

type CloseReason = "normal" | "cancel" | "error";

type CfRequestMetadata = {
  readonly colo?: string;
};

type VersionMetadataEnv = {
  readonly VERSION_METADATA?: WorkerVersionMetadata;
  readonly CF_VERSION_METADATA?: WorkerVersionMetadata;
  readonly SCRIPT_VERSION?: string;
};

type SseConnection = {
  readonly id: number;
  readonly startedAt: number;
  lastWriteAt: number;
  chunks: number;
  bytes: number;
  closed: boolean;
  colo: string;
  scriptVersion: string;
};

type AgeBuckets = {
  readonly lt1m: number;
  readonly m1to5: number;
  readonly m5to30: number;
  readonly m30to60: number;
  readonly gt60m: number;
};

type OtelMetricsSnapshot = {
  readonly spansEnded: number;
  readonly spansExported: number;
  readonly spansDropped: number;
  readonly spanExportFailures: number;
  readonly forceFlushCalls: number;
  readonly forceFlushFailures: number;
  readonly forceFlushDurationMsTotal: number;
  readonly forceFlushDurationMsLast: number;
  readonly maxQueueSize: number;
};

const activeSse = new Map<number, SseConnection>();

let nextConnectionId = 1;
let totalBytesForwarded = 0;
let lastSnapshotEmittedAt = 0;

const otelMetrics = {
  spansEnded: 0,
  spansExported: 0,
  spansDropped: 0,
  spanExportFailures: 0,
  forceFlushCalls: 0,
  forceFlushFailures: 0,
  forceFlushDurationMsTotal: 0,
  forceFlushDurationMsLast: 0,
};

const requestWithCf = (request: Request): Request & { readonly cf?: CfRequestMetadata } =>
  request as Request & { readonly cf?: CfRequestMetadata };

const scriptVersionFromEnv = (env: Env): string => {
  const metadataEnv = env as Env & VersionMetadataEnv;
  return (
    metadataEnv.VERSION_METADATA?.id ??
    metadataEnv.VERSION_METADATA?.tag ??
    metadataEnv.CF_VERSION_METADATA?.id ??
    metadataEnv.CF_VERSION_METADATA?.tag ??
    metadataEnv.SCRIPT_VERSION ??
    ""
  );
};

const utf8ByteCounter = new TextEncoder();

const byteLengthOf = (chunk: unknown): number => {
  if (typeof chunk === "string") return utf8ByteCounter.encode(chunk).length;
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  return 0;
};

const emptyAgeBuckets = (): AgeBuckets => ({
  lt1m: 0,
  m1to5: 0,
  m5to30: 0,
  m30to60: 0,
  gt60m: 0,
});

const bucketAge = (buckets: AgeBuckets, ageMs: number): AgeBuckets => {
  const next = { ...buckets };
  if (ageMs < 60_000) next.lt1m += 1;
  else if (ageMs < 5 * 60_000) next.m1to5 += 1;
  else if (ageMs < 30 * 60_000) next.m5to30 += 1;
  else if (ageMs < 60 * 60_000) next.m30to60 += 1;
  else next.gt60m += 1;
  return next;
};

const otelSnapshot = (maxQueueSize: number): OtelMetricsSnapshot => ({
  ...otelMetrics,
  maxQueueSize,
});

const snapshot = (now: number, maxQueueSize: number) => {
  let oldestConnectionAgeMs = 0;
  let stalledConnections = 0;
  let ageBuckets = emptyAgeBuckets();
  const colos = new Set<string>();
  const scriptVersions = new Set<string>();

  for (const connection of activeSse.values()) {
    const ageMs = now - connection.startedAt;
    oldestConnectionAgeMs = Math.max(oldestConnectionAgeMs, ageMs);
    if (now - connection.lastWriteAt > STALLED_WRITE_MS) stalledConnections += 1;
    ageBuckets = bucketAge(ageBuckets, ageMs);
    if (connection.colo) colos.add(connection.colo);
    if (connection.scriptVersion) scriptVersions.add(connection.scriptVersion);
  }
  const sortedColos = Array.from(colos).sort();
  const sortedScriptVersions = Array.from(scriptVersions).sort();

  return {
    activeSseConnections: activeSse.size,
    ageBuckets,
    oldestConnectionAgeMs,
    totalBytesForwarded,
    stalledConnections,
    stalledWriteThresholdMs: STALLED_WRITE_MS,
    colo: sortedColos[0] ?? "",
    colos: sortedColos,
    scriptVersion: sortedScriptVersions[0] ?? "",
    scriptVersions: sortedScriptVersions,
    otel: otelSnapshot(maxQueueSize),
  };
};

const emitSnapshot = (event: string, now: number, maxQueueSize: number): void => {
  lastSnapshotEmittedAt = now;
  console.log(
    `${LOG_PREFIX} ${JSON.stringify({
      event,
      ...snapshot(now, maxQueueSize),
    })}`,
  );
};

const maybeEmitPeriodicSnapshot = (now: number, maxQueueSize: number): void => {
  if (now - lastSnapshotEmittedAt < PERIODIC_EMIT_INTERVAL_MS) return;
  emitSnapshot("snapshot", now, maxQueueSize);
};

const closeConnection = (
  connection: SseConnection,
  reason: CloseReason,
  maxQueueSize: number,
): void => {
  if (connection.closed) return;
  connection.closed = true;
  activeSse.delete(connection.id);
  const now = Date.now();
  console.log(
    `${LOG_PREFIX} ${JSON.stringify({
      event: "sse_close",
      connectionId: connection.id,
      reason,
      ageMs: now - connection.startedAt,
      bytesForwarded: connection.bytes,
      chunksForwarded: connection.chunks,
      lastWriteAgeMs: now - connection.lastWriteAt,
      colo: connection.colo,
      scriptVersion: connection.scriptVersion,
    })}`,
  );
  maybeEmitPeriodicSnapshot(now, maxQueueSize);
};

const sseHeaders = (headers: Headers): Headers => {
  const next = new Headers(headers);
  next.delete("content-length");
  return next;
};

export const wrapMcpSseResponse = (request: Request, env: Env, response: Response): Response => {
  if (
    request.method !== "GET" ||
    response.body === null ||
    !(response.headers.get("content-type") ?? "").includes("text/event-stream")
  )
    return response;

  const now = Date.now();
  const connection: SseConnection = {
    id: nextConnectionId++,
    startedAt: now,
    lastWriteAt: now,
    chunks: 0,
    bytes: 0,
    closed: false,
    colo: requestWithCf(request).cf?.colo ?? "",
    scriptVersion: scriptVersionFromEnv(env),
  };
  activeSse.set(connection.id, connection);
  emitSnapshot("sse_open", now, OTEL_MAX_SPAN_QUEUE_SIZE);

  const counting = new TransformStream<unknown, unknown>({
    transform(chunk, controller) {
      const written = byteLengthOf(chunk);
      const writeAt = Date.now();
      connection.chunks += 1;
      connection.bytes += written;
      connection.lastWriteAt = writeAt;
      totalBytesForwarded += written;
      maybeEmitPeriodicSnapshot(writeAt, OTEL_MAX_SPAN_QUEUE_SIZE);
      controller.enqueue(chunk);
    },
    flush() {
      closeConnection(connection, "normal", OTEL_MAX_SPAN_QUEUE_SIZE);
    },
    cancel(reason) {
      closeConnection(
        connection,
        reason === undefined ? "cancel" : "error",
        OTEL_MAX_SPAN_QUEUE_SIZE,
      );
    },
  });

  const body = response.body.pipeThrough(counting);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: sseHeaders(response.headers),
  });
};

export const recordForceFlush = (durationMs: number, failed: boolean): void => {
  otelMetrics.forceFlushCalls += 1;
  otelMetrics.forceFlushDurationMsLast = durationMs;
  otelMetrics.forceFlushDurationMsTotal += durationMs;
  if (failed) otelMetrics.forceFlushFailures += 1;
};

export class CountingSpanExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly onExportAttempt: (spans: number) => void,
  ) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    this.onExportAttempt(spans.length);
    this.inner.export(spans, (result) => {
      if (result.code === EXPORT_SUCCESS_CODE) {
        otelMetrics.spansExported += spans.length;
      } else {
        otelMetrics.spansDropped += spans.length;
        otelMetrics.spanExportFailures += 1;
      }
      resultCallback(result);
    });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

export class CountingSpanProcessor implements SpanProcessor {
  private estimatedQueuedSpans = 0;

  constructor(
    private readonly inner: SpanProcessor,
    private readonly maxQueueSize: number,
  ) {}

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  onStart(span: Span, parentContext: Context): void {
    this.inner.onStart(span, parentContext);
  }

  onEnding(span: Span): void {
    this.inner.onEnding?.(span);
  }

  onEnd(span: ReadableSpan): void {
    otelMetrics.spansEnded += 1;
    if (this.estimatedQueuedSpans >= this.maxQueueSize) {
      // At the bound the inner processor would drop this span anyway; drop it
      // here instead of forwarding, so a dropped span is never also counted as
      // exported (which would double-count and inflate the drop signal).
      otelMetrics.spansDropped += 1;
      return;
    }
    this.estimatedQueuedSpans += 1;
    this.inner.onEnd(span);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  recordExportAttempt(spans: number): void {
    this.estimatedQueuedSpans = Math.max(0, this.estimatedQueuedSpans - spans);
  }
}
