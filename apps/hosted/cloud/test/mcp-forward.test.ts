import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit } from "effect";
import { Headers, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { forwardMcpRequest } from "../src/implementation/mcp-forward.ts";

const closed = new Error(
  "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
);
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
const request = (body: unknown, path = "/mcp", session = false) =>
  HttpServerRequest.fromWeb(
    new Request(`https://example.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session ? { "mcp-session-id": "existing-session" } : {}),
      },
      body: JSON.stringify(body),
    }),
  ).modify({
    headers: Headers.fromInput({
      "content-type": "application/json",
      traceparent: "synthetic-trace",
      ...(session ? { "mcp-session-id": "existing-session" } : {}),
    }),
  });

test("initialization reacquires a stub and replays the complete body and trace headers", async () => {
  const bodies: unknown[] = [];
  const response = await Effect.runPromise(
    forwardMcpRequest(request(initialize, "/org/synthetic/mcp"), (incoming) =>
      Effect.gen(function* () {
        assert.equal(incoming.headers.traceparent, "synthetic-trace");
        bodies.push(yield* incoming.json);
        if (bodies.length === 1) return yield* Effect.die(closed);
        return HttpServerResponse.empty({ status: 200 });
      }),
    ),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(bodies, [initialize, initialize]);
});

for (const [name, body, path, session] of [
  ["tool execution", { jsonrpc: "2.0", id: 2, method: "tools/call", params: {} }, "/mcp", false],
  ["batch", [initialize], "/mcp", false],
  ["approval", initialize, "/api/mcp/approvals/request", false],
  ["existing session", initialize, "/mcp", true],
] as const) {
  test(`${name} is never replayed after an ambiguous connection loss`, async () => {
    let attempts = 0;
    const result = await Effect.runPromiseExit(
      forwardMcpRequest(request(body, path, session), () =>
        Effect.suspend(() => {
          attempts++;
          return Effect.die(closed);
        }),
      ),
    );
    assert.equal(attempts, 1);
    assert.ok(Exit.isFailure(result));
    assert.equal(Cause.squash(result.cause), closed);
  });
}

test("repeated closure stops after one reconnect and preserves the original failure", async () => {
  let attempts = 0;
  const result = await Effect.runPromiseExit(
    forwardMcpRequest(request(initialize), () =>
      Effect.suspend(() => {
        attempts++;
        return Effect.die(closed);
      }),
    ),
  );
  assert.equal(attempts, 2);
  assert.ok(Exit.isFailure(result));
  assert.equal(Cause.squash(result.cause), closed);
});

test("unrelated initialization errors propagate without retry", async () => {
  let attempts = 0;
  const error = new Error("unrelated failure");
  const result = await Effect.runPromiseExit(
    forwardMcpRequest(request(initialize), () =>
      Effect.suspend(() => {
        attempts++;
        return Effect.die(error);
      }),
    ),
  );
  assert.equal(attempts, 1);
  assert.ok(Exit.isFailure(result));
  assert.equal(Cause.squash(result.cause), error);
});
