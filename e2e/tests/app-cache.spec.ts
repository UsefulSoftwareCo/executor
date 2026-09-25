import { expect, layer } from "@effect/vitest";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { Effect } from "effect";
import { cacheApp } from "../support/cache-app.ts";

layer(HostedLive, { excludeTestServices: true })("App caching", (it) => {
  it.effect(scenarios.appCache.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { second, request, call } = yield* cacheApp;
        expect(yield* call("expired")).not.toBe(yield* call("expired"));
        expect(yield* call("lazy")).toBe("resolved-without-list");
        const warm = yield* call("cached", { key: "shared" });
        expect(yield* call("cached", { key: "shared" }, second.id)).toBe(warm);
        const refreshedValue = yield* call("refresh", { key: "refresh-check" });
        expect(yield* call("cached", { key: "refresh-check" })).toBe(refreshedValue);
        const nextValue = yield* call("refresh", { key: "refresh-check" });
        expect(nextValue).not.toBe(refreshedValue);
        expect(
          (yield* request("refreshFailed", { key: "refresh-check" })).status,
        ).toBeGreaterThanOrEqual(400);
        expect(yield* call("cached", { key: "refresh-check" })).toBe(nextValue);
        const burst = yield* Effect.all(
          Array.from({ length: 6 }, () => call("cached", { key: "concurrent" })),
          { concurrency: 6 },
        );
        expect(new Set(burst).size).toBe(1);
        yield* call("invalidate", { key: "shared" });
        expect(yield* call("cached", { key: "shared" })).not.toBe(warm);
        expect((yield* request("failed")).status).toBeGreaterThanOrEqual(400);
        expect(yield* call("recovered")).toBe("recovered");
        expect((yield* request("invalid")).status).toBeGreaterThanOrEqual(400);
      }),
    ),
  );
});
