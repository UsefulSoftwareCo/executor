import { expect, layer } from "@effect/vitest";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { Effect, Fiber } from "effect";
import { cacheApp } from "../support/cache-app.ts";

layer(HostedLive, { excludeTestServices: true })("App caching", (it) => {
  it.effect(scenarios.appCacheFences.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { request, call } = yield* cacheApp;
        const held = yield* request("held").pipe(Effect.forkScoped);
        yield* call("heldStarted").pipe(
          Effect.repeat({ until: (value) => value === true }),
          Effect.timeout("10 seconds"),
        );
        yield* call("invalidate", { key: "held" });
        expect(yield* call("replacement")).toBe("replacement");
        yield* call("heldRelease");
        expect((yield* Fiber.join(held).pipe(Effect.timeout("10 seconds"))).status).toBe(502);
        expect(yield* call("replacement")).toBe("replacement");
        expect(yield* call("seed")).toBe("seed");
        // The stale response must finish before releasing the held refresh.
        expect(yield* call("stale").pipe(Effect.timeout("10 seconds"))).toBe("seed");
        yield* call("started").pipe(
          Effect.repeat({ until: (value) => value === true }),
          Effect.timeout("10 seconds"),
        );
        yield* call("release");
        const refreshed = yield* call("stale").pipe(
          Effect.repeat({ until: (value) => value === "refreshed" }),
          Effect.timeout("10 seconds"),
        );
        expect(refreshed).toBe("refreshed");
      }),
    ),
  );
});
