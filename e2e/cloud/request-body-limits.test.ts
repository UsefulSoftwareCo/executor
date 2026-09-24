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
    const health = yield* Effect.promise(() => fetch(new URL("/api/account/me", target.baseUrl)));
    expect(health.status).toBe(401);
  }),
);
