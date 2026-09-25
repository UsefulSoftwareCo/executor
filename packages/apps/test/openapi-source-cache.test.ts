/** Live OpenAPI sources keep large specs off the request path once they are cached. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { Effect } from "effect";
import { sqliteCache } from "@executor-js/app-cache/sqlite";
import { authorCache } from "../src/implementation/cache.ts";
import { liveOpenapiOperations } from "../src/openapi.ts";

const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
});

const document = (operationId: string) => ({
  openapi: "3.0.3",
  info: { title: "Fixture", version: "1" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/items": {
      get: {
        operationId,
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  },
});

/** Real SQLite cache adapter, a controllable clock and a counting, holdable spec server. */
const harness = () => {
  const db = new DatabaseSync(":memory:");
  const store = sqliteCache({
    sql: {
      exec: (query, ...bindings) => {
        const rows = db.prepare(query).all(...bindings);
        return { toArray: () => rows, one: () => rows[0] };
      },
    },
    transactionSync: (work) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  });
  const background: Promise<unknown>[] = [];
  let now = realNow();
  Date.now = () => now;
  let spec = document("first");
  let downloads = 0;
  let hold: Promise<void> | undefined;
  const fetch: typeof globalThis.fetch = async () => {
    downloads++;
    if (hold !== undefined) await hold;
    return Response.json(spec);
  };
  const cache = authorCache(
    {
      transport: (command) => store("build", command),
      background: (task) =>
        Effect.sync(() => {
          background.push(Effect.runPromise(Effect.ignore(task)));
        }),
    },
    {},
    new AbortController().signal,
  );
  const source = () =>
    liveOpenapiOperations({
      cache,
      source: { url: "https://api.example.com/openapi.json" },
      allowedOrigin: "https://api.example.com",
      securitySchemes: {},
      methods: {},
      oauth: [],
      freshFor: "5 minutes",
    }).dynamicTools;
  return {
    source,
    fetch,
    advance: (ms: number) => {
      now += ms;
    },
    publish: (operationId: string) => {
      spec = document(operationId);
    },
    downloads: () => downloads,
    hold: () => {
      let release!: () => void;
      hold = new Promise((resolve) => (release = resolve));
      return () => {
        hold = undefined;
        release();
      };
    },
    settled: () => Promise.all(background.splice(0)),
    rows: () =>
      (db.prepare("SELECT count(*) AS count FROM executor_cache").get() as { count: number }).count,
  };
};

const list = (tools: ReturnType<ReturnType<typeof harness>["source"]>) =>
  Effect.runPromise(tools.list()).then((items) => items.map((tool) => tool.name));

test("an idle listing returns retained tools while the spec refreshes in the background", async () => {
  const h = harness();
  globalThis.fetch = h.fetch;
  assert.deepEqual(await list(h.source()), ["queries.first"]);
  assert.equal(h.downloads(), 1);

  // Well past the five-minute fresh window, as when someone reopens the Tools page.
  h.advance(30 * 60_000);
  h.publish("second");
  const release = h.hold();
  const listed = await Promise.race([
    list(h.source()),
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
  ]);
  assert.deepEqual(listed, ["queries.first"], "listing must not wait for the spec download");
  assert.equal(h.downloads(), 2, "the stale read starts one background refresh");
  release();
  await h.settled();
  assert.deepEqual(await list(h.source()), ["queries.second"]);
});

test("refreshing an unchanged spec reuses its stored revision", async () => {
  const h = harness();
  globalThis.fetch = h.fetch;
  await list(h.source());
  const rows = h.rows();
  for (let refresh = 0; refresh < 3; refresh++) {
    h.advance(10 * 60_000);
    await list(h.source());
    await h.settled();
  }
  assert.equal(h.downloads(), 4);
  assert.equal(h.rows(), rows, "each refresh must not store another copy of the spec");
});
