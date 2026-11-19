/**
 * Paging `tools.search` through the whole catalog, with neither query nor namespace, ranked every
 * row the catalog holds again for each page, so a walk of n tools cost n squared over the page
 * size on the product's one thread. On Nov 18 2026 three such walks over 11,467 tools held a
 * self-hosted product at full CPU for minutes. A search now ranks once and keeps the order for its
 * later pages: past the second, a page reads only its own rows, however large the catalog.
 */
import { expect, layer } from "@effect/vitest";
import { Console, Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { scenarios } from "../test-plan.ts";

const apps = 16;
const toolsPerApp = 500;
const pageItems = 150;

/** An app of `toolsPerApp` small tools, generated when it evaluates. */
const walkSource = (
  index: number,
) => `import { defineApp, object, query, router, string } from "apps";
export default defineApp({}, async () => {
  const tools = {};
  for (let t = 0; t < ${toolsPerApp}; t++)
    tools["walkprobe" + t] = query(
      { description: "Walk probe " + t + " of app ${index}", input: object({ id: string() }) },
      async () => t,
    );
  return { tools: router(tools) };
});`;

/** Every page of a search with neither query nor namespace, counting the probes it lists. */
const walk = `let next = { limit: ${pageItems} };
let seen = 0;
let pages = 0;
while (next !== null) {
  const page = await tools.search(next);
  pages += 1;
  seen += page.items.filter((item) => item.path.includes("walkprobe")).length;
  next = page.next;
}
return { seen, pages };`;

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Walked = Schema.Struct({
  structuredContent: Schema.Struct({
    status: Schema.Literal("completed"),
    execution: Schema.Struct({
      ok: Schema.Literal(true),
      value: Schema.Struct({ seen: Schema.Number, pages: Schema.Number }),
    }),
  }),
});

layer(HostedLive, { excludeTestServices: true })("MCP search walk", (it) => {
  it.effect(scenarios.mcpSearchWalk.title, (context) =>
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
                name: `Search walk ${index} ${run}`,
                files: [{ path: "index.ts", content: walkSource(index) }, appsManifest],
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
          { concurrency: 4, discard: true },
        );
        const created = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "MCP search walk",
        });
        expect(created.status).toBe(200);
        const token = yield* body(Token, created);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: token.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(token.key, "pat", { organization });

        /** Walk the whole catalog in one execute, and read each page's search span and SQL time. */
        const walkOnce = (operation: string) =>
          Effect.gen(function* () {
            const started = Date.now();
            const called = yield* client.use(operation, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code: walk } }, undefined, {
                signal,
              }),
            );
            const elapsed = Date.now() - started;
            const walked = yield* Schema.decodeUnknownEffect(Walked)(called);
            const request = (yield* evidence.requests)
              .filter((request) => request.path === "/mcp")
              .at(-1);
            if (request === undefined)
              return yield* Effect.die(new Error("MCP request evidence missing"));
            const { pages } = walked.structuredContent.execution.value;
            const searches = yield* telemetry.query(request.traceId).pipe(
              Effect.flatMap((result) => {
                if (result.meta?.truncated === true)
                  return Effect.die(new Error("The walk's trace must reach Motel whole"));
                const byId = new Map(result.data.map(({ span }) => [span.spanId, span]));
                const searchOf = (spanId: string | null) => {
                  const visited = new Set<string>();
                  for (let parent = spanId; parent !== null && !visited.has(parent);) {
                    visited.add(parent);
                    const span = byId.get(parent);
                    if (span === undefined) return undefined;
                    if (span.operationName === "sdk.tools.search") return span.spanId;
                    parent = span.parentSpanId;
                  }
                  return undefined;
                };
                const sqlMs = new Map<string, number>();
                for (const { span } of result.data) {
                  if (span.operationName !== "sql.execute") continue;
                  const search = searchOf(span.parentSpanId);
                  if (search !== undefined)
                    sqlMs.set(search, (sqlMs.get(search) ?? 0) + span.durationMs);
                }
                const searches = result.data
                  .filter(({ span }) => span.operationName === "sdk.tools.search")
                  .map(({ span }) => ({
                    startTime: span.startTime,
                    order: span.tags["executor.search.order"] ?? "",
                    durationMs: span.durationMs,
                    sqlMs: sqlMs.get(span.spanId) ?? 0,
                  }))
                  .sort((a, b) => a.startTime.localeCompare(b.startTime));
                return searches.length === pages
                  ? Effect.succeed(searches)
                  : Effect.fail(new Error("Every page's search span must reach Motel"));
              }),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
              Effect.timeout("25 seconds"),
            );
            return { ...walked.structuredContent.execution.value, elapsed, searches };
          });

        // The first walk ranks the catalog for its first page, and again for its second, keeping
        // that order; every later page reads its rows by it. The second walk, over the same
        // listings, ranks its first page and reads every later one by the order the first kept.
        const firstWalk = yield* walkOnce("Walk the whole catalog for the first time");
        const secondWalk = yield* walkOnce("Walk the whole catalog again");
        const summarize = (walked: typeof firstWalk) => {
          const [first, second, ...rest] = walked.searches;
          return {
            pages: walked.pages,
            elapsed: walked.elapsed,
            firstPageSqlMs: first?.sqlMs ?? 0,
            secondPageSqlMs: second?.sqlMs ?? 0,
            laterPagesSqlMs: rest.reduce((sum, search) => sum + search.sqlMs, 0),
            medianLaterPageSqlMs:
              rest.map((search) => search.sqlMs).sort((x, y) => x - y)[
                Math.floor(rest.length / 2)
              ] ?? 0,
            slowestLaterPageSqlMs: Math.max(0, ...rest.map((search) => search.sqlMs)),
            totalSqlMs: walked.searches.reduce((sum, search) => sum + search.sqlMs, 0),
            orders: walked.searches.map((search) => search.order),
          };
        };
        const summary = {
          tools: apps * toolsPerApp,
          first: summarize(firstWalk),
          again: summarize(secondWalk),
        };
        yield* Console.log(JSON.stringify({ label: "Whole-catalog walk", ...summary }));
        yield* evidence.json("mcp-search-walk.json", {
          summary,
          first: firstWalk.searches,
          again: secondWalk.searches,
        });
        yield* evidence.measure("Whole-catalog walk", firstWalk.elapsed);
        yield* evidence.measure("Whole-catalog walk again", secondWalk.elapsed);

        for (const walked of [firstWalk, secondWalk]) {
          expect(walked.seen, "The walk lists every tool once").toBe(apps * toolsPerApp);
          expect(walked.pages).toBeGreaterThan(20);
        }
        const kept = (count: number) => Array.from({ length: count }, () => "kept");
        expect(summary.first.orders).toEqual(["ranked", "ordered", ...kept(firstWalk.pages - 2)]);
        expect(summary.again.orders).toEqual(["ranked", ...kept(secondWalk.pages - 1)]);
        // A kept page reads only its own rows: the typical one costs well under the ranking the
        // first page does, where every page used to cost a ranking.
        for (const walked of [summary.first, summary.again])
          expect(
            walked.medianLaterPageSqlMs,
            `The median kept page read ${walked.medianLaterPageSqlMs} ms of SQL; the first page, which ranks the catalog, ${walked.firstPageSqlMs} ms`,
          ).toBeLessThan(walked.firstPageSqlMs / 2);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
