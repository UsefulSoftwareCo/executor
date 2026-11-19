/**
 * A search past its first page keeps its order for its later pages (see mcp-search-walk), in a
 * cache of at most 32 searches and 6 MB. Two ways a new search could push out one still being
 * paged: many new searches ranking at once each found room before their ranking and evicted the
 * least recently read search after it, idle or not; and a search with a key too large to keep was
 * remembered in the same cache with its key's bytes, past the 6 MB, which evicted every kept
 * search. A search read in the last 30 s is now never evicted, and a search too large to keep is
 * remembered apart from kept orders, or not at all when its key alone is too large.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { scenarios } from "../test-plan.ts";

const apps = 2;
const toolsPerApp = 60;

/** An app of `toolsPerApp` small tools, generated when it evaluates. */
const probeSource = (
  index: number,
) => `import { defineApp, object, query, router, string } from "apps";
export default defineApp({}, async () => {
  const tools = {};
  for (let t = 0; t < ${toolsPerApp}; t++)
    tools["keptprobe" + t] = query(
      { description: "Kept probe " + t + " of app ${index}", input: object({ id: string() }) },
      async () => t,
    );
  return { tools: router(tools) };
});`;

/** Pages a search to its second page, so its order is kept, and returns the third page's request. */
const secondPage = (query: string) => `
const first = await tools.search({ query: ${JSON.stringify(query)}, limit: 10 });
const second = await tools.search(first.next);
return second.next;`;

/** Reads the page a request returned by {@link secondPage} names. */
const thirdPage = (next: unknown) => `
const third = await tools.search(${JSON.stringify(next)});
return third.items.length;`;

/**
 * Pages one search to its second page, then pages a search whose 500 distinct 8,000-character
 * words make a key of about 4 million characters, then reads the first search's third page.
 */
const huge = `
const first = await tools.search({ query: 'kept probe again', limit: 10 });
const second = await tools.search(first.next);
const words = Array.from({ length: 500 }, (_, i) => String(i).padStart(8000, 'w'));
const big = await tools.search({ query: 'kept probe ' + words.join(' '), limit: 10 });
await tools.search(big.next);
const third = await tools.search(second.next);
return third.items.length;`;

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Ran = Schema.Struct({
  structuredContent: Schema.Struct({
    status: Schema.Literal("completed"),
    execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  }),
});

layer(HostedLive, { excludeTestServices: true })("MCP search kept orders", (it) => {
  it.effect(scenarios.mcpSearchKeptOrders.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          mcp = yield* McpClient;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const run = randomUUID().slice(0, 8);
        yield* Effect.forEach(
          Array.from({ length: apps }, (_, index) => index),
          (index) =>
            Effect.gen(function* () {
              const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
                name: `Kept orders ${index} ${run}`,
                files: [{ path: "index.ts", content: probeSource(index) }, appsManifest],
              });
              expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
              const app = yield* body(App, deployed);
              yield* Effect.addFinalizer(() =>
                api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(
                  Effect.map((response) => expect(response.status).toBe(200)),
                  Effect.orDie,
                ),
              );
            }),
          { concurrency: 2, discard: true },
        );
        const created = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "MCP search kept orders",
        });
        expect(created.status).toBe(200);
        const token = yield* body(Token, created);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: token.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(token.key, "pat", { organization });

        /** Run a program and return its value. */
        const execute = (operation: string, code: string) =>
          client
            .use(operation, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Ran)),
              Effect.map((ran) => ran.structuredContent.execution.value),
            );
        /**
         * Run a program alone and read its value and how each of its searches got its page, in
         * order, from the trace of the last MCP request.
         */
        const orders = (operation: string, code: string, searches: number) =>
          Effect.gen(function* () {
            const value = yield* execute(operation, code);
            const request = (yield* evidence.requests)
              .filter((request) => request.path === "/mcp")
              .at(-1);
            if (request === undefined)
              return yield* Effect.die(new Error("MCP request evidence missing"));
            const traced = yield* telemetry.query(request.traceId).pipe(
              Effect.flatMap((result) => {
                const spans = result.data
                  .map(({ span }) => span)
                  .filter((span) => span.operationName === "sdk.tools.search")
                  .sort((a, b) => a.startTime.localeCompare(b.startTime))
                  .map((span) => span.tags["executor.search.order"] ?? "");
                return spans.length === searches
                  ? Effect.succeed(spans)
                  : Effect.fail(new Error("Every search span must reach Motel"));
              }),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
              Effect.timeout("25 seconds"),
            );
            return { value, orders: traced };
          });

        // A search with a key too large to keep ranks each page and evicts nothing.
        const large = yield* orders("Page a search beside one too large to keep", huge, 5);
        yield* evidence.json("huge-orders.json", large.orders);
        expect(large.value).toBe(10);
        expect(large.orders).toEqual(["ranked", "ordered", "ranked", "ranked", "kept"]);

        // Forty new searches keeping their orders at once leave the one being paged kept.
        const paged = yield* orders(
          "Page a search to its second page",
          secondPage("kept probe"),
          2,
        );
        expect(paged.orders).toEqual(["ranked", "ordered"]);
        yield* Effect.forEach(
          Array.from({ length: 40 }, (_, index) => index),
          (index) => execute(`Page new search ${index}`, secondPage(`kept probe z${index}`)),
          { concurrency: "unbounded", discard: true },
        );
        const third = yield* orders(
          "Read the paged search's third page",
          thirdPage(paged.value),
          1,
        );
        expect(third.value).toBe(10);
        expect(third.orders, "The search being paged keeps its order").toEqual(["kept"]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
