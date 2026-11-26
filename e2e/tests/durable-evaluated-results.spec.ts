import { expect, layer } from "@effect/vitest";
import { Console, Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";

const listingSource = (
  delayMs: number,
) => `import { defineApp, query, object, router, string } from "apps";
export default defineApp({}, async (ctx) => {
  await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
  const revision = await ctx.cache.get({
    key: "revision",
    schema: string(),
    freshFor: "1 day",
    load: async () => crypto.randomUUID().replaceAll("-", "").slice(0, 12),
  });
  const padding = "x".repeat(800);
  const listed = Object.fromEntries(
    Array.from({ length: 1500 }, (_, index) => [
      "tool_" + index,
      query({ description: padding, input: object({}) }, async () => index),
    ]),
  );
  return {
    tools: router({
      ...listed,
      ["revision_" + revision]: query({ input: object({}) }, async () => revision),
      bump: query({ input: object({}) }, async () => {
        await ctx.cache.invalidate("revision");
        return true;
      }),
    }),
  };
});`;

const isolateEntryChars = (2 * 1024 * 1024) / 2;

const sharedSource = (
  tools: number,
  padding: number,
  definition: number,
) => `import { defineApp, dynamicRouter, router } from "apps";
const definitions = Object.fromEntries([0, 1, 2, 3].map((d) => ["Model" + d, {
  type: "object",
  description: "Model " + d + " " + "d".repeat(${definition}),
  properties: { id: { type: "string" }, next: { $ref: "#/$defs/Model" + ((d + 1) % 4) } },
}]));
const tools = Array.from({ length: ${tools} }, (_, index) => ({
  name: "tool_" + index,
  description: "Tool " + index + " " + "p".repeat(${padding}),
  inputSchema: {
    type: "object",
    properties: { body: { $ref: "#/$defs/Model" + (index % 4) } },
    $defs: index === 7 ? { ...definitions, Model0: { type: "string" } } : definitions,
  },
  outputSchema: {
    type: "object",
    properties: { items: { type: "array", items: { $ref: "#/$defs/Model1" } } },
    $defs: definitions,
  },
  readOnly: true,
}));
export default defineApp({}, {
  tools: router({ listed: dynamicRouter({ list: async () => tools, resolve: async () => undefined }) }),
});`;

const distinctSource = (
  named: "Defined" | "own",
) => `import { defineApp, dynamicRouter, router } from "apps";
const description = "d".repeat(500);
const tools = Array.from({ length: 12000 }, (_, index) => {
  const value = String(index).padStart(6, "0");
  const name = ${named === "own" ? `"D" + value` : `"Defined"`};
  return {
    name: "tool_" + index,
    description: "Tool " + index,
    inputSchema: {
      type: "object",
      properties: { input: { $ref: "#/$defs/" + name } },
      $defs: { [name]: { description, const: value } },
    },
    readOnly: true,
  };
});
export default defineApp({}, {
  tools: router({ listed: dynamicRouter({ list: async () => tools, resolve: async () => undefined }) }),
});`;

const longNamesSource = (
  lengths: "same" | "own",
) => `import { defineApp, dynamicRouter, router } from "apps";
const tools = Array.from({ length: 1000 }, (_, index) => {
  const length = ${lengths === "same" ? "17000" : "index < 500 ? 16999 - index : 16501 + index"};
  const suffix = String(index).padStart(8, "0");
  return {
    name: "tool_" + index,
    description: "Tool " + index,
    inputSchema: {
      type: "object",
      $defs: { ["N".repeat(length - suffix.length) + suffix]: { type: "string" } },
    },
    readOnly: true,
  };
});
export default defineApp({}, {
  tools: router({ listed: dynamicRouter({ list: async () => tools, resolve: async () => undefined }) }),
});`;

const Listing = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });

const listingApp = (files: string = listingSource(0)) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      telemetry = yield* Telemetry,
      evidence = yield* Evidence;
    const prefix = `/api/organizations/${actors.organization.id}/apps`;
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
      name: `Durable listing ${randomUUID().slice(0, 8)}`,
      files: [{ path: "index.ts", content: files }, appsManifest],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed);
    yield* Effect.addFinalizer(() =>
      api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
    );
    const path = `${prefix}/${app.id}`;

    const read = (label: string, settled: (names: ReadonlyArray<string>) => boolean) =>
      Effect.gen(function* () {
        const response = yield* api.request(actors.owner, "GET", `${path}/tools`);
        expect(response.status, label).toBe(200);
        const names = (yield* body(Listing, response)).items.map((item) => item.name);
        const request = (yield* evidence.requests).at(-1);
        if (request === undefined) return yield* Effect.die(new Error("Missing request"));
        const spans = yield* telemetry.query(request.traceId).pipe(
          Effect.map((result) => result.data.map((row) => row.span)),
          Effect.flatMap((spans) =>
            settled(spans.map((span) => span.operationName))
              ? Effect.succeed(spans)
              : Effect.fail(new Error(`The ${label} trace has not arrived`)),
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
        );
        yield* evidence.json(`${label}.json`, spans);
        const listing = spans.find((span) => span.operationName === "sdk.tools.listing");
        const evaluate = spans.find((span) => span.operationName === "sdk.tools.listing.evaluate");
        const share = spans.find((span) => span.operationName === "sdk.tools.listing.share");
        return {
          names,
          evaluated: evaluate?.tags,
          sharedMs: share?.durationMs,
          page: response.body,
          spans: spans.map((span) => span.operationName),
          revision: names.find((name) => name.startsWith("revision_")),
          cache: listing?.tags["executor.declarations.cache"],
          source: listing?.tags["executor.declarations.source"],
          age: Number(listing?.tags["executor.declarations.age_ms"]),
          decoded: listing?.tags["executor.listing.json_chars"],
        };
      });
    return { api, actors, path, read };
  });

const listed = (names: ReadonlyArray<string>) => names.includes("sdk.tools.listing");
const evaluates = (names: ReadonlyArray<string>) =>
  listed(names) && names.includes("sdk.tools.listing.evaluate");
const written = (names: ReadonlyArray<string>) =>
  evaluates(names) && names.includes("storage.evaluated.write");

layer(HostedLive, { excludeTestServices: true })("Durable evaluated results", (it) => {
  it.effect(scenarios.durableEvaluatedResults.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, path, read } = yield* listingApp();

        const first = yield* read("first-listing", written);
        expect(first.cache).toBe("miss");
        expect(Number(first.evaluated?.["executor.listing.json_chars"])).toBeGreaterThan(
          isolateEntryChars,
        );
        expect(first.decoded).toBeUndefined();
        expect(first.names).toContain("bump");
        expect(first.revision).toBeDefined();

        const second = yield* read("durable-listing", listed);
        expect(second.source).toBe("durable");
        expect(second.cache).toBe("hit");
        expect(second.names).toEqual(first.names);
        expect(Number(second.decoded)).toBeGreaterThan(isolateEntryChars);

        const bumped = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "bump",
          kind: "query",
          input: {},
        });
        expect(bumped.status, JSON.stringify(bumped.body)).toBe(200);
        const third = yield* read("after-invalidation", listed);
        expect(third.cache).toBe("miss");
        expect(third.source).toBeUndefined();
        expect(third.revision).toBeDefined();
        expect(third.revision).not.toBe(first.revision);
      }),
    ),
  );

  it.effect(
    scenarios.durableEvaluatedRefresh.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const { read } = yield* listingApp(listingSource(3_000));
          const first = yield* read("first-listing", written);
          expect(first.cache).toBe("miss");

          yield* Effect.sleep("31 seconds");
          const stale = yield* read("stale-listing", written);
          expect(stale.source).toBe("durable");
          expect(stale.cache).toBe("stale");
          expect(stale.age).toBeGreaterThanOrEqual(30_000);
          expect(stale.spans).toContain("storage.evaluated.write");

          const refreshed = yield* read("refreshed-listing", listed);
          expect(refreshed.source).toBe("durable");
          expect(refreshed.cache).toBe("hit");
          expect(refreshed.age).toBeLessThan(stale.age);
          expect(refreshed.spans).not.toContain("sdk.tools.listing.evaluate");
          expect(refreshed.names).toEqual(first.names);
        }),
      ),
    { timeout: 120_000 },
  );

  it.effect(
    scenarios.durableEvaluatedSharedDefinitions.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const small = yield* listingApp(sharedSource(300, 100, 1200));
          const evaluated = yield* small.read("shared-first-listing", written);
          expect(evaluated.cache).toBe("miss");
          const kept = yield* small.read("shared-kept-listing", listed);
          expect(kept.source).toBe("memory");
          expect(kept.cache).toBe("hit");
          expect(kept.page).toEqual(evaluated.page);

          const large = yield* listingApp(sharedSource(1500, 800, 100));
          const first = yield* large.read("shared-large-listing", written);
          expect(first.cache).toBe("miss");
          const recalled = yield* large.read("shared-durable-listing", listed);
          expect(recalled.source).toBe("durable");
          expect(recalled.cache).toBe("hit");
          expect(recalled.page).toEqual(first.page);
          const tool = (page: unknown, name: string) =>
            Schema.decodeUnknownSync(
              Schema.Struct({
                items: Schema.Array(
                  Schema.Struct({ name: Schema.String, inputSchema: Schema.Unknown }),
                ),
              }),
            )(page).items.find((item) => item.name === name)?.inputSchema;
          expect(tool(recalled.page, "listed.tool_7")).toMatchObject({
            $defs: { Model0: { type: "string" } },
          });
          expect(tool(recalled.page, "listed.tool_8")).toMatchObject({
            $defs: { Model0: { type: "object" } },
          });
        }),
      ),
    { timeout: 120_000 },
  );

  it.effect(
    scenarios.durableEvaluatedDistinctDefinitions.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const control = yield* listingApp(distinctSource("own"));
          const colliding = yield* listingApp(distinctSource("Defined"));
          const own = yield* control.read("own-names-listing", evaluates);
          const same = yield* colliding.read("same-name-listing", evaluates);
          for (const read of [own, same]) {
            expect(read.cache).toBe("miss");
            expect(read.evaluated?.["executor.listing.definitions"]).toBe("12000");
            expect(read.evaluated?.["executor.listing.definition_copies"]).toBe("0");
          }
          expect(same.evaluated?.["executor.listing.json_chars"]).toBe(
            own.evaluated?.["executor.listing.json_chars"],
          );
          expect(Number(own.evaluated?.["executor.listing.definition_comparisons"])).toBe(0);
          expect(Number(same.evaluated?.["executor.listing.definition_comparisons"])).toBe(12_000);
        }),
      ),
    { timeout: 120_000 },
  );

  it.effect(
    scenarios.durableEvaluatedLongDefinitionNames.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const control = yield* listingApp(longNamesSource("own"));
          const colliding = yield* listingApp(longNamesSource("same"));
          const own = yield* control.read("own-length-names-listing", evaluates);
          const same = yield* colliding.read("same-length-names-listing", evaluates);
          for (const read of [own, same]) {
            expect(read.cache).toBe("miss");
            expect(read.evaluated?.["executor.listing.definitions"]).toBe("1000");
            expect(read.evaluated?.["executor.listing.definition_copies"]).toBe("0");
          }
          expect(same.evaluated?.["executor.listing.json_chars"]).toBe(
            own.evaluated?.["executor.listing.json_chars"],
          );
          for (const read of [own, same])
            expect(Number(read.evaluated?.["executor.listing.definition_comparisons"])).toBe(0);
          yield* Console.log(
            JSON.stringify({
              step: "long definition names",
              own: own.sharedMs,
              same: same.sharedMs,
            }),
          );
          if (own.sharedMs === undefined || same.sharedMs === undefined)
            return yield* Effect.die(new Error("Missing interning span"));
          expect(same.sharedMs).toBeLessThan(own.sharedMs * 5 + 100);
        }),
      ),
    { timeout: 120_000 },
  );
});
