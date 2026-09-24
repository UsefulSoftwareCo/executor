import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { introspect } from "./introspect";

describe("GraphQL introspection body limit", () => {
  for (const status of [200, 500]) {
    it.effect(`cancels an oversized streamed ${status} response before parsing`, () =>
      Effect.gen(function* () {
        let cancelled = false;
        const response = new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status, headers: { "content-length": "1" } },
        );
        const client = HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, response)),
        );
        const error = yield* introspect("https://example.test/graphql").pipe(
          Effect.provide(Layer.succeed(HttpClient.HttpClient)(client)),
          Effect.flip,
        );
        expect(error).toHaveProperty("reason", "response-too-large");
        expect(cancelled).toBe(true);
      }),
    );
  }
});
