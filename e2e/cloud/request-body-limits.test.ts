import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { scenario } from "../src/scenario";
import { Target } from "../src/services";

scenario(
  "Request limits · API and MCP reject oversized bodies before parsing",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    for (const path of ["/api/integrations", "/mcp"]) {
      const response = yield* Effect.promise(() =>
        fetch(new URL(path, target.baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "x".repeat(32 * 1024 * 1024 + 1),
        }),
      );
      expect(response.status).toBe(413);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        error: "Request body too large",
      });
    }
    // A streamed request has no Content-Length; the Worker must count real bytes.
    let chunks = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (chunks++ < 33) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      },
    });
    const streamedRequest = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    };
    const streamedResponse = yield* Effect.promise(() =>
      fetch(new URL("/mcp", target.baseUrl), streamedRequest),
    );
    expect(streamedResponse.status).toBe(413);
    expect(yield* Effect.promise(() => streamedResponse.json())).toEqual({
      error: "Request body too large",
    });
    const health = yield* Effect.promise(() => fetch(new URL("/api/account/me", target.baseUrl)));
    expect(health.status).toBe(401);
  }),
);
