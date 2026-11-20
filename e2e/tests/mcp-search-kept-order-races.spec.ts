/**
 * Hold a page at its SQL reply, then evict or replace the order it read. The page still answers
 * from the right listing, but must not put an evicted order back, overwrite the replacement,
 * or discard it on a stamp miss.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Layer, Schedule, Schema } from "effect";
import { Api, body, SessionClients } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { startDevelopmentServer } from "../support/managed-server.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { throttlingCollector } from "../support/throttling-collector.ts";
import { scenarios } from "../test-plan.ts";

const holdPath = "/api/devtools/statement-hold";
const clockPath = "/api/devtools/monotonic-clock";
const Held = Schema.Struct({ held: Schema.Boolean });
const Users = Schema.Struct({
  users: Schema.Array(Schema.Struct({ id: Schema.String, email: Schema.String })),
});
const Organizations = Schema.Array(Schema.Struct({ id: Schema.String }));
const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Ran = Schema.Struct({
  structuredContent: Schema.Struct({
    status: Schema.Literal("completed"),
    execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  }),
});
const Page = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String, description: Schema.String })),
});

/** The revision changes on invalidation without changing the deployment or listing ID. */
const source = `import { defineApp, mutation, object, query, router, string } from "apps";
export default defineApp({}, async (ctx) => {
  const revision = await ctx.cache.get({
    key: "revision", schema: string(), freshFor: "1 day", load: async () => crypto.randomUUID(),
  });
  const tools = {
    bump: mutation({ input: object({}) }, async () => {
      await ctx.cache.invalidate("revision");
      return true;
    }),
  };
  for (let i = 0; i < 40; i++) {
    tools["probe" + i] = query(
      { description: "Kept probe " + i + " revision " + revision, input: object({}) },
      async () => i,
    );
  }
  return { tools: router(tools) };
});`;

/** Test the byte limit below the count limit: each of these keys holds about 1.52 MB. */
const heavyQuery = (index: number) => `
  "kept probe " + Array.from({ length: 190 }, (_, i) =>
    ("word" + ${index} + "x" + i).padEnd(4000, "w")
  ).join(" ")`;

const raceFixture = Effect.gen(function* () {
  const target = yield* Target;
  const evidence = yield* Evidence;
  const collector = yield* throttlingCollector;
  // Only the development test entry point mounts either control.
  const origin = yield* startDevelopmentServer(target, {
    OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
  });
  const api = yield* Api.pipe(
    Effect.provide(Layer.fresh(Api.layer)),
    Effect.provide(Layer.fresh(SessionClients.layer)),
    Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
  );
  const owner = yield* api.session();
  const send = (method: "GET" | "POST" | "DELETE", path: string, payload?: unknown) =>
    api
      .request(owner, method, `${origin}${path}`, payload, { origin })
      .pipe(
        Effect.tap((response) =>
          Effect.sync(() => expect(response.status, `${method} ${path}`).toBe(200)),
        ),
      );
  yield* send("POST", "/api/devtools/operator", {});
  const directory = yield* body(Users, yield* send("GET", "/api/auth/admin/list-users"));
  const developer = directory.users.find((user) => user.email === "agent-agent@example.test");
  if (developer === undefined) return yield* Effect.die("Development owner is missing");
  yield* send("POST", "/api/auth/admin/impersonate-user", { userId: developer.id });
  const [org] = yield* body(Organizations, yield* send("GET", "/api/auth/organization/list"));
  if (org === undefined) return yield* Effect.die("Development organization is missing");
  const prefix = `/api/organizations/${org.id}`;
  const app = yield* body(
    App,
    yield* send("POST", `${prefix}/apps/deploy`, {
      name: "Kept order race",
      files: [{ path: "index.ts", content: source }, appsManifest],
    }),
  );
  const token = yield* body(
    Token,
    yield* send("POST", "/api/auth/api-key/create", { name: "Kept order race" }),
  );
  yield* Effect.addFinalizer(() =>
    send("POST", "/api/auth/api-key/delete", { keyId: token.id }).pipe(Effect.orDie),
  );
  yield* Effect.addFinalizer(() => send("DELETE", clockPath).pipe(Effect.orDie));
  const mcp = yield* McpClient;
  const connect = (label: string) =>
    Effect.gen(function* () {
      const client = yield* mcp.connect(token.key, label, { origin, organization: org.id });
      const execute = (step: string, code: string) =>
        client
          .use(step, (client, signal) =>
            client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
          )
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Ran)),
            Effect.map((ran) => ran.structuredContent.execution.value),
          );
      return {
        /** Each connection reads one program at a time; the held page uses its own connection. */
        search: (step: string, query: string, offset: number) =>
          Effect.gen(function* () {
            // The large query leaves room for only one item in the page budget. Explicit offsets
            // re-read the same rows without returning that query in the program's result.
            const code = `const page = await tools.search({ query: ${query}, offset: ${offset}, limit: 10 });
                          return { items: page.items };`;
            const page = yield* Schema.decodeUnknownEffect(Page)(yield* execute(step, code));
            // The writer finishes before the held reader is released, so no two replies race.
            const response = (yield* evidence.requests).findLast(
              ({ method, path }) => method === "POST" && path === "/mcp",
            );
            if (response === undefined) return yield* Effect.die("Search response trace missing");
            const orders = yield* collector.query(response.traceId).pipe(
              Effect.flatMap(({ data }) => {
                const orders = data
                  .map(({ span }) => span)
                  .filter((span) => span.operationName === "sdk.tools.search")
                  .map((span) => span.tags["executor.search.order"]);
                return orders.length === 1
                  ? Effect.succeed(orders)
                  : Effect.fail(new Error(`${step}: missing search spans`));
              }),
              Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 200 }),
            );
            expect(page.items.length, step).toBeGreaterThan(0);
            return { ...page, orders };
          }),
      };
    });
  const main = yield* connect("orders");
  const reader = yield* connect("held-reader");
  // Start with the revision populated and the listing written before keeping any order.
  expect(
    (yield* main.search("Read the first page to warm the listing", '"kept probe"', 0)).orders,
  ).toEqual(["ranked"]);
  const page = (step: string, query: string) => main.search(step, query, 20);
  const keep = (step: string, query = '"kept probe"') =>
    Effect.gen(function* () {
      const second = yield* main.search(step, query, 10);
      expect(second.orders, step).toEqual(["ordered"]);
      return query;
    });
  const replaceListing = send("POST", `${prefix}/apps/${app.id}/tools/call`, {
    tool: "bump",
    kind: "mutation",
    input: {},
  }).pipe(Effect.tap((response) => Effect.sync(() => expect(response.body).toBe(true))));

  const holdPage = <E, R>(query: string, meanwhile: Effect.Effect<unknown, E, R>) =>
    Effect.gen(function* () {
      yield* send("POST", holdPath, { after: "kept-order" });
      const fiber = yield* Effect.forkChild(reader.search("Read the held page", query, 20));
      yield* send("GET", holdPath).pipe(
        Effect.flatMap((response) => body(Held, response)),
        Effect.filterOrFail(
          ({ held }) => held,
          () => new Error("The kept-order read was not held"),
        ),
        Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 200 }),
      );
      yield* meanwhile;
      yield* send("DELETE", holdPath);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.ensuring(send("DELETE", holdPath).pipe(Effect.orDie)));

  return {
    page,
    keep,
    holdPage,
    replaceListing,
    ageOrders: send("POST", clockPath, { advanceMillis: 31_000 }),
  };
});

layer(HostedLive, { excludeTestServices: true })("MCP kept-order races", (it) => {
  it.effect(scenarios.mcpSearchKeptOrderEvicted.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { page, keep, holdPage, ageOrders } = yield* raceFixture;
        const a = yield* keep("Keep A", heavyQuery(0));
        const before = yield* page("Read A before eviction", a);
        expect(before.orders).toEqual(["kept"]);
        // A must be least recently read at the first admission.
        const b = yield* keep("Keep B", heavyQuery(1));
        const c = yield* keep("Keep C", heavyQuery(2));
        const retained = [b, c];
        const held = yield* holdPage(
          a,
          Effect.gen(function* () {
            yield* ageOrders;
            // Four orders do not fit in 6 MB. D's admission evicts idle A.
            retained.push(yield* keep("Admit D, evicting A", heavyQuery(3)));
          }),
        );
        expect(held.orders).toEqual(["kept"]);
        expect(held.items).toEqual(before.items);
        // On old code the held reply resurrects A without its bytes. After aging again and
        // refreshing B/C/D, room for another order exists only if the pre-check can subtract
        // idle A's uncounted bytes. Fixed code has no A to subtract, so E must only rank.
        yield* ageOrders;
        for (const [i, next] of retained.entries())
          expect((yield* page(`Refresh retained order ${i + 1}`, next)).orders).toEqual(["kept"]);
        const probe = yield* page("Try to admit E", '"kept probe extra"');
        expect(
          probe.orders,
          "A resurrected order must not make room for another admission",
        ).toEqual(["ranked"]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpSearchKeptOrderReplaced.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { page, keep, holdPage, replaceListing } = yield* raceFixture;
        const next = yield* keep("Keep O1");
        const old = yield* page("Read O1", next);
        const held = yield* holdPage(
          next,
          replaceListing.pipe(
            Effect.andThen(page("Admit O2", next)),
            Effect.tap((fresh) =>
              Effect.sync(() => {
                expect(fresh.orders).toEqual(["ordered"]);
                expect(fresh.items).not.toEqual(old.items);
              }),
            ),
          ),
        );
        expect(held.orders).toEqual(["kept"]);
        expect(held.items).toEqual(old.items);
        const after = yield* page("Read the replacement after O1 finishes", next);
        expect(after.items).not.toEqual(old.items);
        expect(after.orders, "O1 must not overwrite O2").toEqual(["kept"]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpSearchKeptOrderStale.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { page, keep, holdPage, replaceListing } = yield* raceFixture;
        yield* keep("Fill the cache with B", heavyQuery(1));
        yield* keep("Fill the cache with C", heavyQuery(2));
        const next = yield* keep("Keep O1", heavyQuery(0));
        const old = yield* page("Read O1", next);
        yield* replaceListing;
        // O1's read has a stale stamp. A second miss drops O1 and admits O2. The three
        // active orders now leave less than 2 MB free, so the held miss must rank without
        // admitting another order. If it drops O2 first, it finds room and orders instead.
        const held = yield* holdPage(
          next,
          page("Admit O2 while O1's stamp miss waits", next).pipe(
            Effect.tap((fresh) =>
              Effect.sync(() => {
                expect(fresh.orders).toEqual(["ordered"]);
                expect(fresh.items).not.toEqual(old.items);
              }),
            ),
          ),
        );
        const after = yield* page("Read the replacement after O1's stamp miss", next);
        expect(held.items).toEqual(after.items);
        expect(held.items).not.toEqual(old.items);
        expect(held.orders, "O1's stamp miss must not discard O2 and admit another order").toEqual([
          "ranked",
        ]);
        expect(after.orders).toEqual(["kept"]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
