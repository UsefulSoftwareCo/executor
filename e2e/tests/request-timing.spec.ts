/** Real browser requests retain the timing headers used to join platform and application traces. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";

layer(HostedLive, { excludeTestServices: true })("Request observability", (it) => {
  it.effect(scenarios.requestTiming.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const name = `Timing ${randomUUID().slice(0, 8)}`;
        const app = yield* body(
          Schema.Struct({ id: Schema.String }),
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name,
            files: [
              {
                path: "index.ts",
                content:
                  'import { defineApp } from "apps"; export default defineApp({accounts:{}},{});',
              },
            ],
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Open the real dashboard", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("Dashboard is mounted", (page) =>
          page.getByText(name, { exact: true }).waitFor(),
        );
        const timings = yield* Effect.forEach([1, 2, 3], (index) =>
          browser.use(`Measure authenticated browser read ${index}`, (page) =>
            page.evaluate((path) => {
              const url = new URL(path, location.origin).href;
              performance.clearResourceTimings();
              return fetch(url).then((response) =>
                response.arrayBuffer().then(() => {
                  const entry = performance.getEntriesByName(url).at(-1);
                  if (!(entry instanceof PerformanceResourceTiming))
                    throw new Error("Missing browser request timing");
                  return {
                    status: response.status,
                    ray: response.headers.get("cf-ray"),
                    duration: entry.duration,
                    waiting: entry.responseStart - entry.requestStart,
                    timings: entry.serverTiming.map(({ name, description, duration }) => ({
                      name,
                      description,
                      duration,
                    })),
                  };
                }),
              );
            }, `${prefix}/apps/${app.id}`),
          ),
        );
        for (const sample of timings) {
          expect(sample.status).toBe(200);
          expect(sample.duration).toBeGreaterThan(0);
          expect(sample.waiting).toBeGreaterThan(0);
          const trace = sample.timings.find((timing) => timing.name === "executor-trace");
          expect(trace?.description).toMatch(/^[a-f0-9]{32}$/);
          const ray = sample.timings.find((timing) => timing.name === "cf-ray");
          expect(ray?.description).toBe(sample.ray?.replace(/-[A-Z]{3}$/i, ""));
          expect(
            sample.timings.find((timing) => timing.name === "executor")?.duration,
          ).toBeGreaterThanOrEqual(0);
        }
        yield* evidence.json("request-timings.json", timings);
        yield* browser.checkpoint("Dashboard request timings are correlated");
      }),
    ),
  );
});
