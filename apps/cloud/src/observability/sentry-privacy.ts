import type { ErrorEvent } from "@sentry/cloudflare";

const SAFE_TAGS = new Set([
  "otel_trace_id",
  "otel_span_id",
  "operation",
  "reason",
  "status",
  "mcp.do.cause_owner",
]);

const identifier = (value: string | undefined): string | undefined =>
  value !== undefined && /^[\w.$<>:/@ -]{1,160}$/.test(value) ? value : undefined;

const sourceFile = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const path = URL.canParse(value) ? new URL(value).pathname : value.split(/[?#]/)[0];
  return path && /^\/?(?:assets\/)?[\w./-]+\.(?:js|mjs|ts|tsx)$/.test(path) ? path : undefined;
};

/** Keep error classification, source positions and correlation; omit all raw payloads. */
export const minimizeSentryEvent = (event: ErrorEvent): ErrorEvent => ({
  type: undefined,
  event_id: event.event_id,
  timestamp: event.timestamp,
  platform: event.platform,
  level: event.level,
  release: event.release,
  environment: event.environment,
  fingerprint: event.fingerprint?.map((part) => identifier(part) ?? "Error"),
  tags: Object.fromEntries(
    Object.entries(event.tags ?? {}).filter(
      ([key, value]) => SAFE_TAGS.has(key) && identifier(String(value)) !== undefined,
    ),
  ),
  exception: {
    values: event.exception?.values?.map((exception) => ({
      type: identifier(exception.type) ?? "Error",
      value: "Details omitted to protect request data",
      mechanism: exception.mechanism
        ? {
            type: identifier(exception.mechanism.type) ?? "generic",
            handled: exception.mechanism.handled,
          }
        : undefined,
      stacktrace: {
        frames: exception.stacktrace?.frames?.map((frame) => ({
          filename: sourceFile(frame.filename),
          function: identifier(frame.function),
          module: identifier(frame.module),
          lineno: frame.lineno,
          colno: frame.colno,
          in_app: frame.in_app,
        })),
      },
    })),
  },
});
