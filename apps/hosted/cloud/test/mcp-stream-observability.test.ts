import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit, Option, Stream, Tracer } from "effect";
import { HttpBody, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { observeMcpStream } from "../src/implementation/mcp-stream-observability.ts";

for (const phase of ["gateway", "session"] as const) {
  test(`${phase} stream closure keeps the request trace after the response handler returns`, async () => {
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const failure = new Error("Network connection lost");
    const response = await Effect.runPromise(
      observeMcpStream(phase)(HttpServerResponse.stream(Stream.die(failure))).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request("https://example.test/mcp")),
        ),
        Effect.withSpan("request"),
        Effect.provideService(Tracer.Tracer, tracer),
      ),
    );
    assert.ok(response.body instanceof HttpBody.Stream);
    const exit = await Effect.runPromiseExit(
      Stream.runDrain(response.body.stream).pipe(
        Effect.withSpan("consumer"),
        Effect.provideService(Tracer.Tracer, tracer),
      ),
    );
    assert.ok(Exit.isFailure(exit));
    assert.equal(Cause.squash(exit.cause), failure);
    const request = spans.find((span) => span.name === "request");
    const closed = spans.find((span) => span.name === "mcp.stream.close");
    assert.ok(request && closed);
    assert.equal(closed.traceId, request.traceId);
    assert.equal(Option.getOrUndefined(closed.parent)?.spanId, request.spanId);
    assert.equal(closed.attributes.get("executor.mcp.stream.phase"), phase);
    assert.equal(closed.attributes.get("executor.mcp.stream.outcome"), "failed");
    assert.equal(closed.attributes.get("executor.mcp.stream.failure"), "disconnected");
    assert.equal(closed.attributes.get("executor.mcp.stream.request_aborted"), false);
  });
}
