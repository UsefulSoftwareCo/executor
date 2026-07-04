import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect } from "@effect/vitest";
import { Effect, Schedule } from "effect";

import { RUNS_DIR, scenario } from "../src/scenario";
import { Target, Telemetry } from "../src/services";

type VerificationResponse = {
  readonly sentryEventId: string;
  readonly otelTraceId: string;
  readonly otelSpanId: string;
};

const beforeSendLogFile = resolve(RUNS_DIR, "cloud", "server-logs", "boot.log");

const hasCorrelationPayload = (line: string, body: VerificationResponse): boolean =>
  line.includes('"event":"sentry_before_send_otel_correlation"') &&
  line.includes(`"sentry_event_id":"${body.sentryEventId}"`) &&
  line.includes(`"otel_trace_id":"${body.otelTraceId}"`) &&
  line.includes(`"otel_span_id":"${body.otelSpanId}"`);

const findBeforeSendPayload = (body: VerificationResponse): Effect.Effect<string, string> =>
  Effect.sync(() => {
    const text = readFileSync(beforeSendLogFile, "utf8");
    return text
      .split("\n")
      .slice()
      .reverse()
      .find((line) => hasCorrelationPayload(line, body));
  }).pipe(
    Effect.filterOrFail(
      (line): line is string => line !== undefined,
      () =>
        `no Sentry beforeSend correlation payload matched ${body.sentryEventId} in ${beforeSendLogFile}`,
    ),
    Effect.retry(Schedule.both(Schedule.spaced("500 millis"), Schedule.recurs(20))),
  );

scenario(
  "Telemetry · Sentry error payload joins to exported OTel span",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const telemetry = yield* Telemetry;

    const response = yield* Effect.promise(() =>
      fetch(new URL("/__sentry-otel-verify", target.baseUrl)),
    );
    expect(response.status).toBe(500);

    const body = (yield* Effect.promise(() => response.json())) as VerificationResponse;
    expect(body.sentryEventId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.otelTraceId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.otelSpanId).toMatch(/^[0-9a-f]{16}$/);

    const beforeSendLine = yield* findBeforeSendPayload(body);
    expect(beforeSendLine).toContain(body.otelTraceId);

    const span = yield* telemetry.expectSpan({
      traceId: body.otelTraceId,
      attributes: {
        "sentry.event_id": body.sentryEventId,
        "sentry_otel.verify": "true",
      },
    });
    expect(span.span.spanId).toBe(body.otelSpanId);
  }),
);
