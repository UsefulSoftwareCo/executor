// ---------------------------------------------------------------------------
// URL redaction at the cloud span-processor seam.
//
// The redaction rules themselves live in `@executor-js/sdk`
// (`telemetry-url-redaction`) and are shared by every exporter path — this
// module only adapts them to the OpenTelemetry SDK's span-processor
// interface, which is the one chokepoint every span in a cloud isolate must
// pass through on its way to the exporter: worker spans, Effect spans,
// Durable Object spans, and any route added later. A per-route middleware or
// a `TracerDisabledWhen` override would only cover the routes someone
// remembered to wire it into.
//
// Four channels are scrubbed: attributes (`url.full` / `url.query` stamped
// unconditionally by Effect's HttpMiddleware.tracer and HttpClient), event
// attributes (`exception.message` / `exception.stacktrace` carry the raw URL
// of a failed request), link attributes (a link to a peer span carries the
// peer's own attribute bag), and the status message. `url.path` is
// deliberately preserved — route-level visibility is what makes these traces
// worth exporting at all.
// ---------------------------------------------------------------------------

import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

import {
  redactSpanUrlAttributes,
  redactStringElements,
  redactUrlsInText,
  STRIPPED_QUERY_ATTRIBUTE,
} from "@executor-js/sdk";

/** The mutable surface of a span the redactor needs: the attribute bag, the
 *  recorded events (exception events carry `exception.message` and
 *  `exception.stacktrace`), the links (each carries its own attribute bag),
 *  and the status (whose `message` carries the failing error's message). Both
 *  `Span` and `ReadableSpan` expose all four as plain mutable objects. */
interface RedactableSpan {
  readonly attributes: Record<string, unknown>;
  readonly events: ReadonlyArray<{
    name: string;
    attributes?: Record<string, unknown> | undefined;
  }>;
  readonly links: ReadonlyArray<{
    attributes?: Record<string, unknown> | undefined;
  }>;
  readonly status: { message?: string | undefined };
}

/** Wraps a span processor so every span is scrubbed of credential-bearing URL
 *  components — in attributes, in event attributes, in link attributes, and
 *  in the status message — before the inner processor (and therefore the
 *  exporter) sees it.
 *
 *  The attribute rewrite happens in `onEnding`, the last hook the OTel SDK
 *  calls while the span is still mutable (`Span.end()` runs `onEnding` before
 *  setting `_ended`, so `setAttribute` still applies); `onEnd` receives a
 *  frozen `ReadableSpan`. `onEnding` is optional in the SpanProcessor
 *  interface, so `onEnd` re-checks the attribute bag and mutates it directly
 *  as a backstop for any SDK path that skips the earlier hook. Events and
 *  status have no setter on an ended span in either hook, so they are always
 *  scrubbed by direct mutation. */
export class UrlRedactingSpanProcessor implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  onStart(span: Span, parentContext: Context): void {
    this.inner.onStart(span, parentContext);
  }

  onEnding(span: Span): void {
    this.redact(span, (key, value) => span.setAttribute(key, value));
    this.inner.onEnding?.(span);
  }

  onEnd(span: ReadableSpan): void {
    this.redact(span, (key, value) => {
      span.attributes[key] = value;
    });
    this.inner.onEnd(span);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  private redact(span: RedactableSpan, write: (key: string, value: string) => void): void {
    // Work on a copy so the redaction decision is made from the current values
    // and applied through the caller's writer (span API vs direct mutation).
    const draft: Record<string, unknown> = { ...span.attributes };
    const stripped = new Set(redactSpanUrlAttributes(draft));
    for (const [name, value] of Object.entries(draft)) {
      if (typeof value === "string" && value !== span.attributes[name]) write(name, value);
    }

    // Links have no setter on an ended span, so their attribute bags are
    // scrubbed by direct mutation — the same full URL-aware pass the span's
    // own attributes get, since a link carries an arbitrary attribute bag.
    for (const link of span.links) {
      if (link.attributes === undefined) continue;
      for (const key of redactSpanUrlAttributes(link.attributes)) stripped.add(key);
    }

    if (stripped.size > 0) write(STRIPPED_QUERY_ATTRIBUTE, Array.from(stripped).sort().join(","));

    for (const event of span.events) {
      const name = redactUrlsInText(event.name);
      if (name !== event.name) event.name = name;
      if (event.attributes === undefined) continue;
      for (const [key, value] of Object.entries(event.attributes)) {
        // Event attributes permit string[] exactly as span attributes do, so
        // array elements get the same free-text scrub, in place.
        if (Array.isArray(value)) {
          redactStringElements(value, redactUrlsInText);
          continue;
        }
        if (typeof value !== "string") continue;
        const redacted = redactUrlsInText(value);
        if (redacted !== value) event.attributes[key] = redacted;
      }
    }

    const message = span.status.message;
    if (typeof message === "string") {
      const redacted = redactUrlsInText(message);
      if (redacted !== message) span.status.message = redacted;
    }
  }
}
