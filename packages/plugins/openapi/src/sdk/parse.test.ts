import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { OpenApiParseError } from "./errors";
import {
  MAX_JSON_SPEC_CHARS,
  MAX_SPEC_TEXT_CHARS,
  MAX_YAML_SPEC_LINES,
  fetchSpecText,
  parse,
} from "./parse";

describe("OpenAPI parse", () => {
  it.effect("parses JSON OpenAPI documents", () =>
    Effect.gen(function* () {
      const doc = yield* parse(
        JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Test", version: "1.0.0" },
          paths: {},
        }),
      );

      expect(doc.openapi).toBe("3.1.0");
    }),
  );

  it.effect("parses YAML OpenAPI documents", () =>
    Effect.gen(function* () {
      const doc = yield* parse(`
openapi: 3.0.0
info:
  title: Test
  version: 1.0.0
paths: {}
`);

      expect(doc.openapi).toBe("3.0.0");
    }),
  );

  it.effect("falls back to YAML for flow-style YAML documents", () =>
    Effect.gen(function* () {
      const doc = yield* parse(`
{
  openapi: 3.0.0,
  info: { title: Test, version: 1.0.0 },
  paths: {}
}
`);

      expect(doc.openapi).toBe("3.0.0");
    }),
  );

  it.effect("returns a stable parse error for empty documents", () =>
    Effect.gen(function* () {
      const error = yield* parse("").pipe(Effect.flip);

      expect(error).toBeInstanceOf(OpenApiParseError);
      expect(error).toHaveProperty("message", "OpenAPI document is empty");
    }),
  );

  it.effect("returns a stable parse error for non-object documents", () =>
    Effect.gen(function* () {
      const error = yield* parse("[]").pipe(Effect.flip);

      expect(error).toBeInstanceOf(OpenApiParseError);
      expect(error).toHaveProperty("message", "OpenAPI document must parse to an object");
    }),
  );

  it.effect("parses Graph-sized YAML OpenAPI documents", () =>
    Effect.gen(function* () {
      const largeDescription = "x".repeat(36 * 1024 * 1024);
      const doc = yield* parse(
        `openapi: 3.0.0
info:
  title: Large Test
  version: 1.0.0
  description: "${largeDescription}"
paths: {}
`,
      );

      expect(doc.info.title).toBe("Large Test");
      expect(doc.info.description).toHaveLength(largeDescription.length);
    }),
  );

  it.effect("rejects structure-dense YAML documents above the line cap", () =>
    Effect.gen(function* () {
      // Three lines per path-item; well past the cap while only a few MB of
      // text — the shape (not the size) is what a whole parse cannot survive.
      const pathItems = "  /a:\n    get: {}\n".repeat(Math.ceil(MAX_YAML_SPEC_LINES / 2));
      const error = yield* parse(
        `openapi: 3.0.0\ninfo:\n  title: Dense\n  version: 1.0.0\npaths:\n${pathItems}`,
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(OpenApiParseError);
      expect(error).toHaveProperty("message", expect.stringMatching(/too large to parse whole/));
      expect(error).toHaveProperty("message", expect.stringMatching(/lines/));
    }),
  );

  it.effect("rejects JSON documents above the JSON size cap", () =>
    Effect.gen(function* () {
      const padded = `{"openapi":"3.1.0","x-pad":"${"x".repeat(MAX_JSON_SPEC_CHARS)}"}`;
      const error = yield* parse(padded).pipe(Effect.flip);

      expect(error).toBeInstanceOf(OpenApiParseError);
      expect(error).toHaveProperty("message", expect.stringMatching(/too large to parse/));
    }),
  );

  it.effect("rejects any document above the text ceiling", () =>
    Effect.gen(function* () {
      const padded = `openapi: 3.0.0\ninfo:\n  description: "${"x".repeat(MAX_SPEC_TEXT_CHARS)}"\n`;
      const error = yield* parse(padded).pipe(Effect.flip);

      expect(error).toBeInstanceOf(OpenApiParseError);
      expect(error).toHaveProperty("message", expect.stringMatching(/too large to parse/));
    }),
  );
});

describe("OpenAPI fetchSpecText", () => {
  const specUrl = "https://example.com/openapi.yaml";

  const layerWithResponse = (response: Response) =>
    Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, response)),
      ),
    );

  it.effect("rejects a document whose declared length is above the text ceiling", () =>
    Effect.gen(function* () {
      const error = yield* fetchSpecText(specUrl).pipe(
        Effect.provide(
          layerWithResponse(
            new Response("openapi: 3.0.0", {
              status: 200,
              headers: { "content-length": String(MAX_SPEC_TEXT_CHARS + 1) },
            }),
          ),
        ),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(OpenApiParseError);
      expect(error).toHaveProperty("message", expect.stringMatching(/too large to parse/));
    }),
  );

  it.effect("fetches a document with an in-range declared length", () =>
    Effect.gen(function* () {
      const specText = yield* fetchSpecText(specUrl).pipe(
        Effect.provide(layerWithResponse(new Response("openapi: 3.0.0", { status: 200 }))),
      );

      expect(specText).toBe("openapi: 3.0.0");
    }),
  );
});
