import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import {
  createExecutor,
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import { makeOpenApiHttpApiTestIntegrationConfig, unwrapInvocation } from "../testing";

import { collectStreamingBody, STREAM_MAX_BYTES } from "./invoke";
import { openApiPlugin } from "./plugin";

const testPlugins = () =>
  [openApiPlugin({ httpClientLayer: FetchHttpClient.layer }), memoryCredentialsPlugin()] as const;

const STREAM_TOOL = "logs.getLogs";

const LogsGroup = HttpApiGroup.make("logs").add(
  HttpApiEndpoint.get("getLogs", "/logs", {
    success: Schema.Unknown,
  }),
);

const StreamingApi = HttpApi.make("streamingResponseTest")
  .add(LogsGroup)
  .annotateMerge(OpenApi.annotations({ title: "StreamingResponseTest", version: "1.0.0" }));

const buildExecutor = (baseUrl: string) =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
    yield* executor.openapi.addSpec(
      makeOpenApiHttpApiTestIntegrationConfig(StreamingApi, { slug: "streaming", baseUrl }),
    );
    yield* executor.connections.create({
      owner: "org",
      name: ConnectionName.make("main"),
      integration: IntegrationSlug.make("streaming"),
      template: AuthTemplateSlug.make("apiKey"),
      value: "token",
    });
    return {
      executor,
      address: ToolAddress.make(`tools.streaming.org.main.${STREAM_TOOL}`),
    };
  });

const startRawServer = (handler: (res: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.callback<{ baseUrl: string; close: () => void }>((resume) => {
      const sockets = new Set<Socket>();
      const server = createServer((req, res) => {
        if (req.url?.split("?")[0] !== "/logs") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        handler(res);
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        resume(
          Effect.succeed({
            baseUrl: `http://127.0.0.1:${port}`,
            close: () => {
              for (const socket of sockets) socket.destroy();
              server.close();
            },
          }),
        );
      });
    }),
    (server) => Effect.sync(() => server.close()),
  );

const encoder = new TextEncoder();

const delayedReadableStream = (
  chunks: readonly Uint8Array[],
  delayMs: number,
  options: { close: boolean },
) =>
  Stream.fromReadableStream({
    evaluate: () => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      return new ReadableStream<Uint8Array>({
        start: (controller) => {
          chunks.forEach((chunk, index) => {
            timers.push(
              setTimeout(() => {
                controller.enqueue(chunk);
                if (options.close && index === chunks.length - 1) {
                  controller.close();
                }
              }, index * delayMs),
            );
          });
        },
        cancel: () => {
          for (const timer of timers) clearTimeout(timer);
        },
      });
    },
    onError: (error) => error,
  });

describe("OpenAPI streaming responses", () => {
  it.effect("returns from an oversized NDJSON stream with truncation metadata", () =>
    Effect.gen(function* () {
      const rows = Array.from(
        { length: 6 },
        (_, index) => `${JSON.stringify({ index, phase: "immediate" })}\n`,
      ).join("");
      const rowBytes = encoder.encode(rows);
      const partialBytes = encoder.encode(`{"partial":"${"x".repeat(STREAM_MAX_BYTES)}"`);

      const result = yield* collectStreamingBody(
        Stream.make(rowBytes, partialBytes),
        "application/stream+json",
      );

      expect(result.headers["x-executor-stream"]).toBe("truncated");
      expect(result.headers["x-executor-stream-bytes"]).toBe(String(STREAM_MAX_BYTES));
      expect(Array.isArray(result.data)).toBe(true);
      const data = result.data as unknown[];
      expect(data.slice(0, 6)).toEqual(
        Array.from({ length: 6 }, (_, index) => ({ index, phase: "immediate" })),
      );
    }),
  );

  it.effect("collects every chunk from a delayed ReadableStream", () =>
    Effect.gen(function* () {
      const chunks = [
        encoder.encode(`${JSON.stringify({ id: 1 })}\n`),
        encoder.encode(`${JSON.stringify({ id: 2 })}\n`),
        encoder.encode(`${JSON.stringify({ id: 3 })}\n`),
      ];
      const expectedBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);

      const result = yield* collectStreamingBody(
        delayedReadableStream(chunks, 75, { close: true }),
        "application/x-ndjson",
        { maxBytes: STREAM_MAX_BYTES, maxMs: 1_000 },
      );

      console.log(
        JSON.stringify({
          case: "delayed-readable-complete",
          bytes: result.headers["x-executor-stream-bytes"],
          rows: Array.isArray(result.data) ? result.data.length : 0,
        }),
      );
      expect(result.headers["x-executor-stream"]).toBe("complete");
      expect(result.headers["x-executor-stream-bytes"]).toBe(String(expectedBytes));
      expect(result.data).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    }),
  );

  it("timeout truncation preserves all chunks received before interruption", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const chunks = [
          encoder.encode(`${JSON.stringify({ id: 1 })}\n`),
          encoder.encode(`${JSON.stringify({ id: 2 })}\n`),
        ];
        const expectedBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const startedAt = Date.now();

        const result = yield* collectStreamingBody(
          delayedReadableStream(chunks, 100, { close: false }),
          "application/stream+json",
          { maxBytes: STREAM_MAX_BYTES, maxMs: 500 },
        );
        const elapsedMs = Date.now() - startedAt;

        console.log(
          JSON.stringify({
            case: "delayed-readable-timeout",
            elapsedMs,
            bytes: result.headers["x-executor-stream-bytes"],
            rows: Array.isArray(result.data) ? result.data.length : 0,
          }),
        );
        expect(elapsedMs).toBeGreaterThanOrEqual(450);
        expect(elapsedMs).toBeLessThan(1_500);
        expect(result.headers["x-executor-stream"]).toBe("truncated");
        expect(result.headers["x-executor-stream-bytes"]).toBe(String(expectedBytes));
        expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
      }),
    );
  });

  it.effect("drops a trailing partial JSON line when the byte cap truncates", () =>
    Effect.gen(function* () {
      let body = "";
      for (let index = 0; Buffer.byteLength(body) < STREAM_MAX_BYTES - 2_000; index++) {
        body += `${JSON.stringify({ index, value: "x".repeat(512) })}\n`;
      }
      const encoded = encoder.encode(`${body}{"partial":"${"y".repeat(STREAM_MAX_BYTES)}"`);

      const result = yield* collectStreamingBody(Stream.make(encoded), "application/x-ndjson");

      expect(result.headers["x-executor-stream"]).toBe("truncated");
      expect(Array.isArray(result.data)).toBe(true);
      const data = result.data as unknown[];
      expect(data.length).toBeGreaterThan(0);
      expect(data.every((row: unknown) => typeof row === "object" && row !== null)).toBe(true);
      expect(data.some((row: unknown) => "partial" in (row as Record<string, unknown>))).toBe(
        false,
      );
    }),
  );

  it.effect("parses a completed short NDJSON stream", () =>
    Effect.gen(function* () {
      const server = yield* startRawServer((res) => {
        res.writeHead(200, { "content-type": "application/jsonl" });
        res.end(`${JSON.stringify({ id: 1 })}\n${JSON.stringify({ id: 2 })}\n`);
      });
      const { executor, address } = yield* buildExecutor(server.baseUrl);

      const result = unwrapInvocation<unknown[]>(yield* executor.execute(address, {}));

      expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
      expect(result.headers?.["x-executor-stream"]).toBe("complete");
    }),
  );

  it.effect("leaves ordinary JSON responses on the buffered path", () =>
    Effect.gen(function* () {
      const server = yield* startRawServer((res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      const { executor, address } = yield* buildExecutor(server.baseUrl);

      const result = unwrapInvocation<Record<string, unknown>>(
        yield* executor.execute(address, {}),
      );

      expect(result.data).toEqual({ ok: true });
      expect(result.headers?.["x-executor-stream"]).toBeUndefined();
    }),
  );

  it.effect("leaves non-2xx JSON error responses on the buffered path", () =>
    Effect.gen(function* () {
      const server = yield* startRawServer((res) => {
        res.writeHead(422, { "content-type": "application/json" });
        res.end('{"error":{"field":"name","reason":"too_short"}}');
      });
      const { executor, address } = yield* buildExecutor(server.baseUrl);

      const exit = yield* executor.execute(address, {}).pipe(Effect.exit);
      const text = Exit.match(exit, {
        onFailure: (cause) => JSON.stringify(cause),
        onSuccess: (value) => JSON.stringify(value),
      });

      expect(text).toMatch(/422|too_short|name|response|error/i);
      expect(text).not.toMatch(/x-executor-stream/);
    }),
  );

  it.effect("advertises an NDJSON operation's output as the array invoke returns", () =>
    Effect.gen(function* () {
      // The spec declares the schema of ONE line (Vercel's runtime-logs
      // convention); the runtime returns an array of parsed lines. The
      // advertised output schema must describe that array on BOTH serve
      // paths (the add-time compile and the stored-binding rebuild) or
      // agents write code against a shape that never comes back.
      const lineSchema = {
        type: "object",
        properties: { level: { type: "string" }, message: { type: "string" } },
      };
      const server = yield* startRawServer((res) => {
        res.writeHead(200, { "content-type": "application/stream+json" });
        res.end(
          `${JSON.stringify({ level: "info", message: "a" })}\n` +
            `${JSON.stringify({ level: "error", message: "b" })}\n`,
        );
      });

      const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
      yield* executor.openapi.addSpec({
        spec: {
          kind: "blob",
          value: JSON.stringify({
            openapi: "3.0.3",
            info: { title: "Runtime Logs", version: "1.0.0" },
            servers: [{ url: server.baseUrl }],
            paths: {
              "/logs": {
                get: {
                  operationId: "getLogs",
                  tags: ["logs"],
                  responses: {
                    "200": {
                      description: "Log lines",
                      content: { "application/stream+json": { schema: lineSchema } },
                    },
                  },
                },
              },
            },
          }),
        },
        slug: "ndjson_logs",
        baseUrl: server.baseUrl,
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("ndjson_logs"),
        template: AuthTemplateSlug.make("apiKey"),
        value: "token",
      });
      const address = ToolAddress.make("tools.ndjson_logs.org.main.logs.getLogs");

      const schema = yield* executor.tools.schema(address);
      const outputSchema = schema?.outputSchema as Record<string, unknown>;
      expect(outputSchema.type).toBe("array");
      expect(outputSchema.items).toEqual(lineSchema);

      // Force a catalog rebuild (the stored-binding serve path) to re-derive
      // the same array wrap from the persisted content type.
      yield* executor.connections.refresh({
        owner: "org",
        integration: IntegrationSlug.make("ndjson_logs"),
        name: ConnectionName.make("main"),
      });
      const rebuilt = yield* executor.tools.schema(address);
      const rebuiltOutput = rebuilt?.outputSchema as Record<string, unknown>;
      expect(rebuiltOutput.type).toBe("array");
      expect(rebuiltOutput.items).toEqual(lineSchema);

      // And the runtime value is exactly that array.
      const result = unwrapInvocation<unknown[]>(yield* executor.execute(address, {}));
      expect(result.data).toEqual([
        { level: "info", message: "a" },
        { level: "error", message: "b" },
      ]);
    }),
  );
});
