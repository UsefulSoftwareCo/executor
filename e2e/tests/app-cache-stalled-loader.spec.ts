import { expect, layer } from "@effect/vitest";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { Clock, Effect, Fiber } from "effect";
import { cacheApp } from "../support/cache-app.ts";

layer(HostedLive, { excludeTestServices: true })("App caching", (it) => {
  it.effect(scenarios.appCacheStalledLoader.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { request, call } = yield* cacheApp;
        const holder = yield* request("stalled").pipe(Effect.forkScoped);
        yield* call("stalledStarted").pipe(
          Effect.repeat({ until: (value) => value === true }),
          Effect.timeout("10 seconds"),
        );
        const started = yield* Clock.currentTimeMillis;
        const readers = yield* Effect.all(
          [call("stalledReader"), call("stalledReader"), call("stalledReader")],
          { concurrency: "unbounded" },
        ).pipe(Effect.timeout("25 seconds"));
        const waited = (yield* Clock.currentTimeMillis) - started;
        for (const value of readers) expect(value).toEqual(expect.any(String));
        expect(waited).toBeLessThan(25_000);
        yield* call("stalledRelease");
        expect((yield* Fiber.join(holder).pipe(Effect.timeout("15 seconds"))).status).toBe(502);
        const published = yield* call("stalledReader").pipe(Effect.timeout("10 seconds"));
        expect(readers).not.toContain(published);
        expect(yield* call("stalledReader").pipe(Effect.timeout("5 seconds"))).toBe(published);
      }),
    ),
  );
});
