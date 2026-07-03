import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { clearCompiledOpenApiSpecCache, compileOpenApiSpecCached } from "./backing";

const specText = (title: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title, version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/me": {
        get: {
          operationId: "getMe",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { email: { type: "string" } } },
                },
              },
            },
          },
        },
      },
    },
  });

describe("compileOpenApiSpecCached", () => {
  it("reuses the compiled result for the same spec hash", () => {
    clearCompiledOpenApiSpecCache();
    const text = specText("Cached API");
    const first = Effect.runSync(compileOpenApiSpecCached("hash-a", text));
    const second = Effect.runSync(compileOpenApiSpecCached("hash-a", text));
    // Reference equality proves the second call skipped recompilation.
    expect(second).toBe(first);
  });

  it("recompiles when the spec hash changes", () => {
    clearCompiledOpenApiSpecCache();
    const first = Effect.runSync(compileOpenApiSpecCached("hash-a", specText("V1")));
    const second = Effect.runSync(compileOpenApiSpecCached("hash-b", specText("V2")));
    expect(second).not.toBe(first);
    expect(second.title).toBe("V2");
  });

  it("bypasses the cache when no hash is available", () => {
    clearCompiledOpenApiSpecCache();
    const text = specText("No hash");
    const first = Effect.runSync(compileOpenApiSpecCached(undefined, text));
    const second = Effect.runSync(compileOpenApiSpecCached(undefined, text));
    expect(second).not.toBe(first);
  });

  it("evicts the oldest entry past capacity", () => {
    clearCompiledOpenApiSpecCache();
    const first = Effect.runSync(compileOpenApiSpecCached("hash-0", specText("Zero")));
    for (let index = 1; index <= 4; index++) {
      Effect.runSync(compileOpenApiSpecCached(`hash-${index}`, specText(`Spec ${index}`)));
    }
    // hash-0 was evicted by the four newer entries, so it recompiles.
    const again = Effect.runSync(compileOpenApiSpecCached("hash-0", specText("Zero")));
    expect(again).not.toBe(first);
  });
});
