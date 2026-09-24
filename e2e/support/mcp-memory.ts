/** Public MCP stream probes with scoped cancellation and payload-free evidence. */
import { Clock, Effect, Option, Redacted, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { Target, driver } from "./platform.ts";
import { Evidence } from "./evidence.ts";

const Acknowledgement = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.Literal("notifications/subscriptions/acknowledged"),
});

const TransportCode = Schema.Literals([
  "UND_ERR_SOCKET",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNRESET",
  "ETIMEDOUT",
]);
const TransportError = Schema.Struct({
  name: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Struct({ code: Schema.optional(Schema.String) })),
});
// Raw errors may contain URLs or headers. Retain only known transport codes.
const transportCode = (cause: unknown) => {
  const parsed = Schema.decodeUnknownOption(TransportError)(cause);
  if (Option.isNone(parsed)) return "UNKNOWN";
  const code = parsed.value.cause?.code ?? parsed.value.code;
  if (Schema.is(TransportCode)(code)) return code;
  return parsed.value.name === "AbortError" ? "ABORTED" : "UNKNOWN";
};

/** Hold one real subscription and observe its terminal state without retaining frames. */
export const openMcpSubscription = (input: {
  readonly token: Redacted.Redacted<string>;
  readonly organization: string;
  readonly id: number;
}) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const evidence = yield* Evidence;
    const started = yield* Clock.currentTimeMillis;
    const traceId = randomBytes(16).toString("hex");
    yield* evidence.json(`subscription-${input.id}.json`, { id: input.id, traceId, started });
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) => Effect.sync(() => controller.abort()),
    );
    const response = yield* driver("open MCP memory subscription", (signal) =>
      fetch(new URL("/mcp", target.metadata.origin), {
        method: "POST",
        signal: AbortSignal.any([signal, controller.signal]),
        headers: {
          authorization: `Bearer ${Redacted.value(input.token)}`,
          "x-executor-organization": input.organization,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "subscriptions/listen",
          traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: input.id,
          method: "subscriptions/listen",
          params: {
            notifications: { toolsListChanged: true },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
    ).pipe(Effect.timeout("60 seconds"));
    if (response.status !== 200 || response.body === null) {
      controller.abort();
      return yield* Effect.die(new Error(`MCP subscription returned ${response.status}`));
    }
    const responseBody = response.body;
    const reader = yield* Effect.acquireRelease(
      Effect.sync(() => responseBody.getReader()),
      (reader) =>
        Effect.gen(function* () {
          const cancelRequestedAt = yield* Clock.currentTimeMillis;
          controller.abort();
          const cancellation = yield* driver("cancel MCP memory subscription", () =>
            reader.cancel(),
          ).pipe(Effect.match({ onSuccess: () => "resolved", onFailure: () => "rejected" }));
          yield* evidence.json(`subscription-${input.id}-closed.json`, {
            id: input.id,
            traceId,
            cancelRequestedAt,
            closedAt: yield* Clock.currentTimeMillis,
            cancellation,
          });
        }),
    );
    let buffered = "";
    let initialBytes = 0;
    const decoder = new TextDecoder();
    yield* Effect.gen(function* () {
      while (true) {
        const chunk = yield* driver("read MCP acknowledgement", () => reader.read());
        if (chunk.done)
          return yield* Effect.die(new Error("MCP stream ended before acknowledgement"));
        initialBytes += chunk.value.byteLength;
        buffered += decoder.decode(chunk.value, { stream: true });
        if (buffered.length > 16384)
          return yield* Effect.die(new Error("Oversized MCP acknowledgement"));
        let end: number;
        while ((end = buffered.indexOf("\n\n")) !== -1) {
          const frame = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          // SSE comments carry no event. The acknowledgement remains required.
          if (data === undefined) continue;
          yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Acknowledgement))(data.slice(6));
          return;
        }
      }
    }).pipe(Effect.timeout("30 seconds"));
    let outcome: "open" | "ended" | "transport-error" = "open";
    let bytes = initialBytes;
    let lastReceivedAt = yield* Clock.currentTimeMillis;
    let endedAt: number | undefined;
    let failureCode: ReturnType<typeof transportCode> | undefined;
    yield* Effect.gen(function* () {
      while (true) {
        const next = yield* driver("consume MCP subscription", () => reader.read());
        if (next.done) {
          outcome = "ended";
          endedAt = yield* Clock.currentTimeMillis;
          return;
        }
        bytes += next.value.byteLength;
        lastReceivedAt = yield* Clock.currentTimeMillis;
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          outcome = "transport-error";
          failureCode = transportCode(Redacted.value(error.cause));
          endedAt = yield* Clock.currentTimeMillis;
        }),
      ),
      Effect.forkScoped,
    );
    return Effect.sync(() => ({
      id: input.id,
      traceId,
      rayId: response.headers.get("cf-ray"),
      started,
      endedAt,
      lastReceivedAt,
      outcome,
      failureCode,
      bytes,
    }));
  });
