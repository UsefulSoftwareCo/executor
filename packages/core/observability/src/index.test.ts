import { describe, expect, it } from "@effect/vitest";
import { Effect, Logger, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  httpAccessLogger,
  jsonSpanLogger,
  observabilityLayer,
  parseLogLevel,
  parseOtlpHeaders,
  structuredLoggerLayer,
} from "./index";

describe("parseOtlpHeaders", () => {
  it("parses the standard key=value,key2=value2 format", () => {
    expect(parseOtlpHeaders("authorization=Bearer abc,x-dataset=prod")).toEqual({
      authorization: "Bearer abc",
      "x-dataset": "prod",
    });
  });

  it("trims whitespace around keys and values", () => {
    expect(parseOtlpHeaders(" a = 1 , b = 2 ")).toEqual({ a: "1", b: "2" });
  });

  it("keeps '=' inside values", () => {
    expect(parseOtlpHeaders("authorization=Basic dXNlcj1wdw==")).toEqual({
      authorization: "Basic dXNlcj1wdw==",
    });
  });

  it("drops malformed pairs and tolerates blank input", () => {
    expect(parseOtlpHeaders("novalue,=orphan,ok=1")).toEqual({ ok: "1" });
    expect(parseOtlpHeaders(undefined)).toEqual({});
    expect(parseOtlpHeaders("  ")).toEqual({});
  });
});

describe("parseLogLevel", () => {
  it("maps common level strings case-insensitively", () => {
    expect(parseLogLevel("debug")).toBe("Debug");
    expect(parseLogLevel("WARN")).toBe("Warn");
    expect(parseLogLevel("warning")).toBe("Warn");
  });

  it("returns undefined for unknown or absent values", () => {
    expect(parseLogLevel("verbose")).toBeUndefined();
    expect(parseLogLevel(undefined)).toBeUndefined();
  });
});

const decodeLogLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

describe("jsonSpanLogger", () => {
  const captureLines = async (program: Effect.Effect<void>): Promise<string[]> => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => {
      lines.push(String(line));
    };
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test must restore the patched console.error on any outcome
    try {
      await Effect.runPromise(
        program.pipe(Effect.provide(Logger.layer([jsonSpanLogger], { mergeWithExisting: false }))),
      );
    } finally {
      console.error = original;
    }
    return lines;
  };

  it("emits one JSON line with level, message, and annotations", async () => {
    const lines = await captureLines(
      Effect.logInfo("mcp.tool.end").pipe(Effect.annotateLogs({ "mcp.tool.name": "execute" })),
    );
    expect(lines).toHaveLength(1);
    const record = decodeLogLine(lines[0]!);
    expect(record.level).toBe("INFO");
    expect(record.message).toBe("mcp.tool.end");
    expect(record.annotations).toEqual({ "mcp.tool.name": "execute" });
    expect(record.trace_id).toBeUndefined();
  });

  it("includes trace_id/span_id when a span is active", async () => {
    const lines = await captureLines(Effect.log("inside").pipe(Effect.withSpan("test.span")));
    const record = decodeLogLine(lines[0]!);
    expect(typeof record.trace_id).toBe("string");
    expect(typeof record.span_id).toBe("string");
  });
});

describe("httpAccessLogger", () => {
  type CapturedLog = ReturnType<(typeof Logger.formatStructured)["log"]>;

  const runWithRequest = async (
    url: string,
    app: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>,
  ): Promise<CapturedLog[]> => {
    const records: CapturedLog[] = [];
    const captureLogger = Logger.make((options) => {
      records.push(Logger.formatStructured.log(options));
    });
    await Effect.runPromise(
      httpAccessLogger(app).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request(url)),
        ),
        Effect.provide(Logger.layer([captureLogger], { mergeWithExisting: false })),
        Effect.ignore,
      ),
    );
    return records;
  };

  it("composes method, path, and status into the message", async () => {
    const records = await runWithRequest(
      "http://localhost/api/things?id=42#frag",
      Effect.succeed(HttpServerResponse.empty({ status: 201 })),
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.message).toMatch(/^GET \/api\/things 201 in \d+ms$/);
    expect(records[0]!.annotations).toMatchObject({
      "http.method": "GET",
      "http.url": "/api/things",
      "http.status": 201,
    });
    expect(typeof records[0]!.annotations["http.duration_ms"]).toBe("number");
  });

  it("logs failures with the cause and no status", async () => {
    const records = await runWithRequest(
      "http://localhost/missing",
      Effect.fail("route not found"),
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.message).toMatch(/^GET \/missing failed in \d+ms$/);
    expect(records[0]!.annotations["http.status"]).toBeUndefined();
  });
});

describe("layers", () => {
  it("structuredLoggerLayer applies the minimum log level", async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => {
      lines.push(String(line));
    };
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test must restore the patched console.error on any outcome
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.logDebug("hidden");
          yield* Effect.logWarning("shown");
        }).pipe(Effect.provide(structuredLoggerLayer({ logLevel: "warn" }))),
      );
    } finally {
      console.error = original;
    }
    expect(lines).toHaveLength(1);
    expect(decodeLogLine(lines[0]!).message).toBe("shown");
  });

  it("observabilityLayer without endpoint builds without network access", async () => {
    const layer = observabilityLayer({ serviceName: "test", logLevel: "info" });
    await Effect.runPromise(Effect.provide(Effect.void, layer));
  });

  it("observabilityLayer with endpoint builds and shuts down cleanly", async () => {
    // No collector is listening; the exporters buffer in the background and
    // must not fail layer construction or teardown.
    const layer = observabilityLayer({
      serviceName: "test",
      endpoint: "http://127.0.0.1:1",
      headers: "a=1",
    });
    await Effect.runPromise(Effect.provide(Effect.log("buffered"), layer));
  });

  it("observabilityLayer keeps the minimum level visible alongside OTLP layers", async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => {
      lines.push(String(line));
    };
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test must restore the patched console.error on any outcome
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.logInfo("hidden");
          yield* Effect.logError("shown");
        }).pipe(
          Effect.provide(
            observabilityLayer({
              serviceName: "test",
              endpoint: "http://127.0.0.1:1",
              logLevel: "error",
            }),
          ),
        ),
      );
    } finally {
      console.error = original;
    }
    const messages = lines.map((line) => decodeLogLine(line).message);
    expect(messages).toEqual(["shown"]);
  });
});
