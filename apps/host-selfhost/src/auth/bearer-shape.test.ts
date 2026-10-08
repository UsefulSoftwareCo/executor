import { describe, expect, it } from "@effect/vitest";

import { bearerShapeMemoFor, bearerTokenOf, makeBearerShapeMemo } from "./bearer-shape";

describe("bearer shape memo", () => {
  it("remembers and forgets API key bearers without keeping the token", () => {
    const memo = makeBearerShapeMemo();
    expect(memo.isApiKey("key-one")).toBe(false);
    memo.rememberApiKey("key-one");
    expect(memo.isApiKey("key-one")).toBe(true);
    expect(memo.isApiKey("key-two")).toBe(false);
    memo.forget("key-one");
    expect(memo.isApiKey("key-one")).toBe(false);
    expect(memo.size()).toBe(0);
  });

  it("drops the oldest entry past its bound", () => {
    const memo = makeBearerShapeMemo();
    for (let i = 0; i < 1024; i++) memo.rememberApiKey(`key-${i}`);
    expect(memo.size()).toBe(1024);
    memo.rememberApiKey("key-new");
    expect(memo.size()).toBe(1024);
    expect(memo.isApiKey("key-0")).toBe(false);
    expect(memo.isApiKey("key-1")).toBe(true);
    expect(memo.isApiKey("key-new")).toBe(true);
  });

  it("is shared per Better Auth instance", () => {
    const first = {};
    const second = {};
    bearerShapeMemoFor(first).rememberApiKey("key");
    expect(bearerShapeMemoFor(first).isApiKey("key")).toBe(true);
    expect(bearerShapeMemoFor(second).isApiKey("key")).toBe(false);
  });

  it("reads a bearer token case-insensitively and ignores other schemes", () => {
    expect(bearerTokenOf(new Headers({ authorization: "Bearer abc" }))).toBe("abc");
    expect(bearerTokenOf(new Headers({ authorization: "bearer  abc " }))).toBe("abc");
    expect(bearerTokenOf(new Headers({ authorization: "Basic abc" }))).toBeUndefined();
    expect(bearerTokenOf(new Headers({ authorization: "Bearer " }))).toBeUndefined();
    expect(bearerTokenOf(new Headers())).toBeUndefined();
  });
});
