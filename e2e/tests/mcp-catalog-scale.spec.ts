/** Execute stays fast against a large organization catalog with several stalled apps. */
import { expect, layer } from "@effect/vitest";
import { Clock, Console, Effect, Schedule, Schema } from "effect";
import { createServer, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App, Resource } from "../support/contracts.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { appsManifest, withApps } from "../support/apps-release.ts";

/**
 * 28 apps of 175 tools and one imported API of 2,100 tools: 7,000 tools with about 46 MB of JSON
 * input schemas, the size of a self-hosted organization that imported several large APIs. Every
 * schema is distinct. The large app needs two 2,000-tool pages.
 */
const appCount = 28;
const toolsPerApp = 175;
const largeApp = appCount;
const largeAppTools = 2_100;
/**
 * Stalled apps and the enabled profiles each one has. Every profile is a separate tool listing,
 * so together they hold more listings than discovery runs at once (eight).
 */
const stalledApps = 3;
const profilesPerStalledApp = 2;

/** Tool schemas are generated when the app evaluates, so each deploy uploads a small source. */
const scaleAppSource = (
  index: number,
  tools: number,
) => `import { defineApp, query, jsonSchema, router } from "apps";
const app = ${index};
const verbs = ["List", "Get", "Create", "Update", "Delete", "Search", "Export", "Archive"];
const resources = ["accounts", "invoices", "orders", "customers", "shipments", "tickets", "reports", "projects", "members", "webhooks", "payouts", "subscriptions"];
const text = (subject, n) => subject + " for the synthetic " + resources[n % resources.length] + " collection. Accepts the identifier or slug returned by an earlier list call, is case-sensitive, and must not exceed " + (64 + (n % 7) * 32) + " characters. Values that do not match an existing record are ignored rather than rejected.";
const schema = (t) => {
  const body = {};
  for (let p = 0; p < 11; p++) {
    const description = text("Field " + p + " of request " + t, app + t + p);
    body["field_" + p] =
      p % 4 === 0 ? { type: "array", description, items: { type: "object", properties: { key: { type: "string", description: text("Entry key", p) }, value: { type: "string", description: text("Entry value", p + 1) } }, required: ["key"] } }
      : p % 4 === 1 ? { type: "string", description, enum: ["draft", "open", "pending", "active", "paused", "closed", "archived", "deleted"] }
      : p % 4 === 2 ? { type: "integer", description, minimum: 0, maximum: 10000 }
      : { type: "string", description };
  }
  return { type: "object", properties: {
    path: { type: "object", properties: { id: { type: "string", description: text("Record identifier", t) } }, required: ["id"] },
    query: { type: "object", properties: { cursor: { type: "string", description: text("Pagination cursor", t) }, limit: { type: "integer", minimum: 1, maximum: 100, description: text("Page size", t) } } },
    body: { type: "object", properties: body },
  }, required: ["path"] };
};
export default defineApp({ accounts: {} }, async () => {
  const tools = {};
  for (let t = 0; t < ${tools}; t++)
    tools["op" + t] = query(
      { description: verbs[t % verbs.length] + " " + resources[t % resources.length] + " in synthetic scale app " + app + " (marker zq" + app + "x" + t + "q).", input: jsonSchema(schema(t)) },
      async (_ctx, input) => ({ app, tool: t, id: input.path.id }),
    );
  return { tools: router(tools) };
});`;

// An MCP server on a machine that accepts the connection and then never answers.
const stalledAppSource = (origin: string) => `import { defineApp } from "apps";
import { mcpRouter } from "apps/mcp";
export default defineApp({ accounts: {} }, async () => ({ tools: await mcpRouter({ url: ${JSON.stringify(`${origin}/mcp`)} }) }));`;

/** A loopback listener that accepts every connection and never responds. */
const stalledServer = Effect.acquireRelease(
  Effect.callback<{ server: ReturnType<typeof createServer>; sockets: Set<Socket> }>((resume) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, sockets })));
  }),
  ({ server, sockets }) =>
    Effect.callback<void>((resume) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.flatMap(({ server }) => {
    const address = server.address();
    return address !== null && typeof address === "object"
      ? Effect.succeed(`http://127.0.0.1:${address.port}`)
      : Effect.die(new Error("Stalled server requires a TCP listener"));
  }),
);

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ kind: Schema.String, message: Schema.String })),
  }),
  unavailableApps: Schema.Array(Schema.Struct({ app: Schema.String, reason: Schema.String })),
});
const SearchValue = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String, signature: Schema.String })),
});

/**
 * `return 1` touches no app, so its cost must not depend on the catalog: one MCP round trip and
 * the app inventory read, tens of milliseconds on a developer machine. One second leaves CI more
 * than ten times that, and stays below what listing 7,000 tools costs even warm on a fast
 * machine (about 1.9 s; 4.9 s cold).
 */
const trivialBoundMs = 1_000;
/** One call loads one app's catalog, 175 tools and about 1.2 MB of schemas, not all 29 apps. */
const oneAppBoundMs = 1_500;
/**
 * The first catalog-wide search evaluates all 29 apps and renders 7,000 signatures, 3.7–10.4 s on
 * an M-series laptop depending on its load. It must leave the program at least half of the 30 s
 * execution budget. This bound has the least headroom; a failure on a slower runner is a
 * regression to investigate, not a reason to raise it.
 */
const catalogSearchBoundMs = 15_000;
/**
 * A repeated catalog-wide search reuses every kept listing and its rendered search descriptions.
 * What remains is one MCP round trip, one access-checked store read per listing and scoring 7,000
 * descriptions, tens of milliseconds on an M-series laptop. 500 ms leaves a slower runner several
 * times that, and is under a sixth of the fastest cold search (3.7 s), so any search that
 * evaluates the catalog again fails it.
 */
const warmSearchBoundMs = 500;
/**
 * How long discovery waits for the apps a search needs before it may give up on any. Stalled
 * apps delay a catalog-wide search by about this much, never by their connection timeout or the
 * whole execution budget.
 */
const discoveryWaitMs = 10_000;
/**
 * Other apps are listed while the stalled ones wait, so the wait is the only extra cost however
 * many listings stall, and the search finishes inside the 30 s budget they used to exhaust.
 */
const searchBoundMs = discoveryWaitMs + catalogSearchBoundMs;

/** How long the slow app's upstream takes to answer: twice the discovery wait. */
const slowListingMs = 20_000;
/**
 * A search that reports the slow app while its listing runs, or reuses the listing afterwards,
 * does not wait for it: 17–385 ms on an M-series laptop. These scenarios run on the isolated scale
 * runner, not beside the rest of the self-host suite, where one such execute took up to 1.7 s. A
 * quarter of the discovery wait leaves a slower runner several times that and still fails any
 * search that waits for the app again.
 */
const reportedBoundMs = discoveryWaitMs / 4;
/**
 * How long a listing nobody waits for may run before it is stopped and remembered as timed out:
 * the default `loadMillis` of self-host and local.
 */
const listingLoadMs = 45_000;

/**
 * A loopback catalog that holds every request until `recover` is called, then answers held and
 * later requests at once. It counts requests.
 */
const heldCatalog = Effect.acquireRelease(
  Effect.callback<{
    server: ReturnType<typeof createHttpServer>;
    requests: { count: number };
    recover: () => void;
  }>((resume) => {
    const requests = { count: 0 };
    let healthy = false;
    const held = new Set<import("node:http").ServerResponse>();
    const answer = (response: import("node:http").ServerResponse) => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(["alpha", "beta", "gamma"]));
    };
    const server = createHttpServer((request, response) => {
      requests.count += 1;
      if (healthy) return answer(response);
      held.add(response);
      request.on("close", () => held.delete(response));
    });
    const recover = () => {
      healthy = true;
      for (const response of held) answer(response);
      held.clear();
    };
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, requests, recover })));
  }),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.flatMap(({ server, requests, recover }) => {
    const address = server.address();
    return address !== null && typeof address === "object"
      ? Effect.succeed({ url: `http://127.0.0.1:${address.port}/catalog`, requests, recover })
      : Effect.die(new Error("Held catalog requires a TCP listener"));
  }),
);

/** A loopback catalog that answers every request after `slowListingMs` and counts requests. */
const slowCatalog = Effect.acquireRelease(
  Effect.callback<{ server: ReturnType<typeof createHttpServer>; requests: { count: number } }>(
    (resume) => {
      const requests = { count: 0 };
      const server = createHttpServer((request, response) => {
        requests.count += 1;
        const timer = setTimeout(() => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(["alpha", "beta", "gamma"]));
        }, slowListingMs);
        request.on("close", () => clearTimeout(timer));
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, requests })));
    },
  ),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.flatMap(({ server, requests }) => {
    const address = server.address();
    return address !== null && typeof address === "object"
      ? Effect.succeed({ url: `http://127.0.0.1:${address.port}/catalog`, requests })
      : Effect.die(new Error("Slow catalog requires a TCP listener"));
  }),
);

/** Tools come from a slow upstream the factory awaits on every evaluation, without the app cache. */
const slowAppSource = (
  url: string,
  marker = "zqslowq",
) => `import { defineApp, query, object, router } from "apps";
export default defineApp({ accounts: {} }, async (ctx) => {
  const response = await ctx.fetch(${JSON.stringify(url)}, { signal: ctx.signal });
  const names = await response.json();
  return { tools: router(Object.fromEntries(names.map((name) => [name, query(
    { description: "Slow catalog tool " + name + " (marker ${marker}).", input: object({}) },
    async () => name,
  )]))) };
});`;

/**
 * Every evaluation names itself, so a search shows whether it reused a listing. The description
 * also carries the deployed version and the selected account's stored token.
 */
const probeAppSource = (
  version: string,
) => `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const service = defineProvider({ name: "Listing fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: { service } }, async (ctx) => {
  const evaluation = crypto.randomUUID();
  return { tools: router({ probe: query(
    { description: "Listing probe ${version} token " + ctx.accounts.service.fields.token + " evaluation " + evaluation + ".", input: object({}) },
    async () => evaluation,
  ) }) };
});`;

const SearchDescriptions = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String, description: Schema.String })),
});

/** An API key and MCP connection for one actor, removed when the case ends. */
const connectActor = (actor: Session, label: string, organization: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const mcp = yield* McpClient;
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actor, "POST", "/api/auth/api-key/create", { name: label }),
    );
    yield* Effect.addFinalizer(() =>
      api.request(actor, "POST", "/api/auth/api-key/delete", { keyId: key.id }).pipe(Effect.orDie),
    );
    const client = yield* mcp.connect(key.key, label, { organization });
    return (step: string, code: string) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const result = yield* client.use(step, (client, signal) =>
          client.callTool({ name: "execute", arguments: { code } }, undefined, {
            signal,
            timeout: 55_000,
          }),
        );
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        yield* Console.log(JSON.stringify({ step, elapsed }));
        return {
          elapsed,
          completed: yield* Schema.decodeUnknownEffect(Completed)(result.structuredContent),
        };
      });
  });

layer(HostedLive, { excludeTestServices: true })("MCP catalog scale", (it) => {
  it.effect(scenarios.mcpCatalogScale.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Catalog scale",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const deploy = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name,
              files: files.some((file) => file.path === "package.json")
                ? files
                : [...files, appsManifest],
            });
            expect(response.status).toBe(200);
            return yield* body(App, response);
          });
        const run = randomUUID().slice(0, 8);
        const deployStarted = yield* Clock.currentTimeMillis;
        const apps = yield* Effect.forEach(
          Array.from({ length: appCount + 1 }, (_, index) => index),
          (index) =>
            deploy(`Scale ${String(index).padStart(2, "0")} ${run}`, [
              {
                path: "index.ts",
                content: scaleAppSource(index, index === largeApp ? largeAppTools : toolsPerApp),
              },
            ]),
          { concurrency: 4 },
        );
        const deployMs = (yield* Clock.currentTimeMillis) - deployStarted;
        const client = yield* mcp.connect(key.key, "catalog-scale", {
          organization: actors.organization.id,
        });
        const samples: Array<{ label: string; elapsed: number }> = [];
        const execute = (label: string, code: string) =>
          Effect.gen(function* () {
            const started = yield* Clock.currentTimeMillis;
            const result = yield* client.use(label, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, {
                signal,
                timeout: 55_000,
              }),
            );
            const elapsed = (yield* Clock.currentTimeMillis) - started;
            samples.push({ label, elapsed });
            yield* evidence.json("catalog-scale.json", { deployMs, samples });
            yield* Console.log(JSON.stringify({ label, elapsed }));
            return {
              elapsed,
              completed: yield* Schema.decodeUnknownEffect(Completed)(result.structuredContent),
            };
          });
        const target = apps[17]!;
        const call = `return await tools[${JSON.stringify(target.slug)}].op123({ path: { id: "rec_1" } });`;
        const large = apps[largeApp]!;
        // One tool of a small app, and one on the large app's second tool page.
        const needle = `const small = await tools.search({ query: "zq17x123q" });
const large = await tools.search({ query: "zq${largeApp}x999q" });
return { items: [...small.items, ...large.items] };`;
        const found = [
          `tools[${JSON.stringify(target.slug)}].op123`,
          `tools[${JSON.stringify(large.slug)}].op999`,
        ];

        // A program that uses no app does not pay for the catalog, cold or warm.
        for (const attempt of [1, 2, 3]) {
          const trivial = yield* execute(`return 1 (${attempt})`, "return 1;");
          expect(trivial.completed.execution).toMatchObject({ ok: true, value: 1 });
          expect(trivial.elapsed).toBeLessThan(trivialBoundMs);
        }
        // A call into one app loads that app, not the other 39.
        const called = yield* execute("Call one tool", call);
        expect(called.completed.execution).toMatchObject({
          ok: true,
          value: { app: 17, tool: 123, id: "rec_1" },
        });
        expect(called.elapsed).toBeLessThan(oneAppBoundMs);
        // A catalog-wide search lists every app and finds the one matching tool.
        const searchedAll = yield* execute("Search the whole catalog", needle);
        expect(searchedAll.completed.execution.ok).toBe(true);
        expect(
          (yield* Schema.decodeUnknownEffect(SearchValue)(searchedAll.completed.execution.value))
            .items,
        ).toMatchObject(found.map((path) => ({ path })));
        expect(searchedAll.completed.unavailableApps).toEqual([]);
        expect(searchedAll.elapsed).toBeLessThan(catalogSearchBoundMs);
        // Later searches reuse the evaluated listings instead of evaluating all 29 apps again.
        for (const attempt of [1, 2, 3]) {
          const warm = yield* execute(`Search the whole catalog again (${attempt})`, needle);
          expect(warm.completed.execution.ok).toBe(true);
          expect(
            (yield* Schema.decodeUnknownEffect(SearchValue)(warm.completed.execution.value)).items,
          ).toMatchObject(found.map((path) => ({ path })));
          expect(warm.completed.unavailableApps).toEqual([]);
          expect(warm.elapsed).toBeLessThan(warmSearchBoundMs);
        }

        // MCP apps on a machine that accepts connections and never answers join the catalog. Each
        // is listed for the app and for every enabled profile, and every listing stalls.
        const origin = yield* stalledServer;
        const stalled = yield* Effect.forEach(
          Array.from({ length: stalledApps }, (_, index) => index),
          (index) =>
            Effect.gen(function* () {
              const app = yield* deploy(`Offline MCP ${index} ${run}`, [
                {
                  path: "package.json",
                  content: JSON.stringify({
                    dependencies: withApps({
                      "@modelcontextprotocol/client": "2.0.0",
                      "@modelcontextprotocol/core": "2.0.0",
                    }),
                  }),
                },
                { path: "index.ts", content: stalledAppSource(origin) },
              ]);
              for (let profile = 0; profile < profilesPerStalledApp; profile++)
                yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
              return app.id;
            }),
        );

        // Programs that do not touch the stalled apps are not delayed by them.
        const unaffected = yield* execute("return 1 beside stalled apps", "return 1;");
        expect(unaffected.completed.execution).toMatchObject({ ok: true, value: 1 });
        expect(unaffected.elapsed).toBeLessThan(trivialBoundMs);
        const calledAgain = yield* execute("Call one tool beside stalled apps", call);
        expect(calledAgain.completed.execution).toMatchObject({ ok: true });
        expect(calledAgain.elapsed).toBeLessThan(oneAppBoundMs);

        // A catalog-wide search finds both tools and reports only the stalled apps, all of them
        // within one discovery wait rather than one per stalled listing.
        const searched = yield* execute("Search the whole catalog beside stalled apps", needle);
        expect(searched.completed.execution.ok).toBe(true);
        const items = (yield* Schema.decodeUnknownEffect(SearchValue)(
          searched.completed.execution.value,
        )).items;
        expect(items.map((item) => item.path)).toEqual(found);
        expect(items[0]!.signature).toContain("field_10");
        const unavailable = searched.completed.unavailableApps;
        expect(new Set(unavailable.map((entry) => entry.app))).toEqual(new Set(stalled));
        for (const entry of unavailable) expect(entry.reason).toContain("timed out");
        expect(searched.elapsed).toBeGreaterThanOrEqual(discoveryWaitMs - 1_000);
        expect(searched.elapsed).toBeLessThan(searchBoundMs);

        // The stalled listings keep running in the background. Searching again reports the same
        // apps at once instead of waiting for them again, and still finds the other apps' tools.
        for (const attempt of [1, 2]) {
          const again = yield* execute(
            `Search the whole catalog beside stalled apps again (${attempt})`,
            needle,
          );
          expect(again.completed.execution.ok).toBe(true);
          expect(
            (yield* Schema.decodeUnknownEffect(SearchValue)(
              again.completed.execution.value,
            )).items.map((item) => item.path),
          ).toEqual(found);
          const reported = again.completed.unavailableApps;
          expect(new Set(reported.map((entry) => entry.app))).toEqual(new Set(stalled));
          for (const entry of reported) expect(entry.reason).toContain("timed out");
          expect(again.elapsed).toBeLessThan(warmSearchBoundMs);
        }
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.mcpSlowListing.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const upstream = yield* slowCatalog;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Slow catalog ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: slowAppSource(upstream.url) }, appsManifest],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const execute = yield* connectActor(actors.owner, "Slow listing", actors.organization.id);
        const search = `return await tools.search({ query: "zqslowq" });`;
        const paths = (value: unknown) =>
          Schema.decodeUnknownEffect(SearchValue)(value).pipe(
            Effect.map(({ items }) => items.map((item) => item.path).sort()),
          );
        const tools = ["alpha", "beta", "gamma"].map(
          (name) => `tools[${JSON.stringify(app.slug)}].${name}`,
        );

        // The first search waits for discovery's bound, then reports the slow app unavailable.
        const first = yield* execute("Search beside a slow app", search);
        expect(first.completed.execution.ok).toBe(true);
        expect(first.completed.unavailableApps.map((entry) => entry.app)).toEqual([app.id]);
        expect(first.completed.unavailableApps[0]!.reason).toContain("timed out");
        expect(first.elapsed).toBeGreaterThanOrEqual(discoveryWaitMs - 1_000);
        expect(upstream.requests.count).toBe(1);

        // Its listing continues in the background. Searches meanwhile report the app at once,
        // then find its tools as soon as that one listing finishes.
        const loaded = yield* Effect.gen(function* () {
          const polled = yield* execute("Search while the slow listing runs", search);
          expect(polled.completed.execution.ok).toBe(true);
          expect(polled.elapsed).toBeLessThan(reportedBoundMs);
          if (polled.completed.unavailableApps.length === 0) return polled;
          expect(polled.completed.unavailableApps.map((entry) => entry.app)).toEqual([app.id]);
          expect(polled.completed.unavailableApps[0]!.reason).toContain("timed out");
          return yield* Effect.fail("still loading" as const);
        }).pipe(
          Effect.retry({
            schedule: Schedule.spaced("500 millis"),
            while: (error) => error === "still loading",
            times: 60,
          }),
        );
        expect(yield* paths(loaded.completed.execution.value)).toEqual(tools);
        expect(upstream.requests.count).toBe(1);

        // Later searches reuse that listing: the slow upstream is not asked again.
        for (const attempt of [1, 2]) {
          const again = yield* execute(`Search the slow app again (${attempt})`, search);
          expect(again.completed.unavailableApps).toEqual([]);
          expect(yield* paths(again.completed.execution.value)).toEqual(tools);
          expect(again.elapsed).toBeLessThan(reportedBoundMs);
        }
        expect(upstream.requests.count).toBe(1);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(
    scenarios.mcpRememberedListingFailure.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const upstream = yield* heldCatalog;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Stalled catalog ${randomUUID().slice(0, 8)}`,
            files: [
              { path: "index.ts", content: slowAppSource(upstream.url, "zqheldq") },
              appsManifest,
            ],
          });
          expect(deployed.status).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const execute = yield* connectActor(
            actors.owner,
            "Remembered listing failure",
            actors.organization.id,
          );
          const search = `return await tools.search({ query: "zqheldq" });`;
          /** A search that reports the app unavailable without waiting for it, and why. */
          const reported = (step: string) =>
            Effect.gen(function* () {
              const result = yield* execute(step, search);
              expect(result.completed.execution.ok).toBe(true);
              expect(result.elapsed).toBeLessThan(reportedBoundMs);
              expect(result.completed.unavailableApps.map((entry) => entry.app)).toEqual([app.id]);
              const reason = result.completed.unavailableApps[0]!.reason;
              expect(reason).toContain("timed out");
              return reason;
            });
          /** Only a remembered failure, not a listing still running, says this. */
          const remembered = "a later listing finishes";

          const began = yield* Clock.currentTimeMillis;
          const first = yield* execute("Search beside a stalled app", search);
          expect(first.completed.unavailableApps.map((entry) => entry.app)).toEqual([app.id]);
          expect(first.elapsed).toBeGreaterThanOrEqual(discoveryWaitMs - 1_000);
          expect(upstream.requests.count).toBe(1);

          // Searches report the app at once while its listing runs. Once it has run for the load
          // bound with nobody waiting, it is stopped and its timeout remembered.
          yield* Effect.gen(function* () {
            const reason = yield* reported("Search while the stalled listing runs");
            if (reason.includes(remembered)) return;
            expect(upstream.requests.count).toBe(1);
            return yield* Effect.fail("still running" as const);
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced("1 second"),
              while: (error) => error === "still running",
              times: 90,
            }),
          );
          expect((yield* Clock.currentTimeMillis) - began).toBeGreaterThanOrEqual(
            listingLoadMs - 1_000,
          );

          // Reading the remembered failure started one background retry, which asks the upstream
          // again and is held too. Further searches report the failure at once and start no more.
          yield* Effect.gen(function* () {
            if (upstream.requests.count < 2) return yield* Effect.fail("not retried" as const);
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced("100 millis"),
              while: (error) => error === "not retried",
              times: 50,
            }),
          );
          for (const attempt of [1, 2, 3])
            expect(yield* reported(`Search beside the remembered failure (${attempt})`)).toContain(
              remembered,
            );
          expect(upstream.requests.count).toBe(2);

          // The upstream recovers and answers the retry; the next searches find the app's tools.
          upstream.recover();
          const found = yield* Effect.gen(function* () {
            const result = yield* execute("Search after the upstream recovers", search);
            expect(result.completed.execution.ok).toBe(true);
            if (result.completed.unavailableApps.length > 0)
              return yield* Effect.fail("not recovered" as const);
            return result;
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced("200 millis"),
              while: (error) => error === "not recovered",
              times: 25,
            }),
          );
          expect(
            (yield* Schema.decodeUnknownEffect(SearchValue)(found.completed.execution.value)).items
              .map((item) => item.path)
              .sort(),
          ).toEqual(
            ["alpha", "beta", "gamma"].map((name) => `tools[${JSON.stringify(app.slug)}].${name}`),
          );
          expect(upstream.requests.count).toBe(2);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 150_000 },
  );

  it.effect(scenarios.mcpListingInputs.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Listing inputs ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: probeAppSource("first") }, appsManifest],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        const accounts: Array<{ actor: Session; id: string }> = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
            for (const item of accounts)
              yield* api.request(item.actor, "DELETE", `${prefix}/accounts/${item.id}`);
          }).pipe(Effect.orDie),
        );
        const Access = Schema.Struct({ revision: Schema.String });
        const access = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const submit = (actor: Session, connection: string, token: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actor,
              "POST",
              `${prefix}/connections/${connection}/submit`,
              { method: "key", label: `Account ${token}`, fields: { token } },
            );
            expect(response.status).toBe(200);
            return (yield* body(Resource, response)).id;
          });
        /** Connect a new personal account and select it in the profile. */
        const connect = (actor: Session, profile: string, token: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actor, "POST", `${path}/connections`, {
              profile,
              requirement: "service",
              destination: { kind: "personal" },
            });
            expect(response.status).toBe(200);
            const account = yield* submit(actor, (yield* body(Resource, response)).id, token);
            accounts.push({ actor, id: account });
            return account;
          });
        /** Replace an account's stored credential; its ID and selection stay. */
        const reconnect = (actor: Session, account: string, token: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actor,
              "POST",
              `${prefix}/accounts/${account}/connections`,
            );
            expect(response.status).toBe(200);
            expect(yield* submit(actor, (yield* body(Resource, response)).id, token)).toBe(account);
          });
        const owner = yield* connectActor(actors.owner, "Owner listings", actors.organization.id);
        const member = yield* connectActor(
          actors.member,
          "Member listings",
          actors.organization.id,
        );
        /** The one probe tool this actor's profile lists, and which evaluation described it. */
        const probe = (execute: typeof owner, step: string) =>
          Effect.gen(function* () {
            const result = yield* execute(
              step,
              `return await tools.search({ query: "probe", namespace: ${JSON.stringify(app.slug)} });`,
            );
            expect(result.completed.execution.ok).toBe(true);
            expect(result.completed.unavailableApps).toEqual([]);
            const { items } = yield* Schema.decodeUnknownEffect(SearchDescriptions)(
              result.completed.execution.value,
            );
            expect(items).toHaveLength(1);
            const match = / probe (\w+) token (\w+) evaluation ([0-9a-f-]+)\./.exec(
              items[0]!.description,
            );
            expect(match).not.toBeNull();
            const [, version = "", token = "", evaluation = ""] = match ?? [];
            return { version, token, evaluation };
          });
        /** A new evaluation with the expected inputs, which the next identical search reuses. */
        const evaluated = (
          execute: typeof owner,
          step: string,
          expected: { version: string; token: string },
          previous: ReadonlyArray<string>,
        ) =>
          Effect.gen(function* () {
            const listed = yield* probe(execute, step);
            expect(listed).toMatchObject(expected);
            expect(previous).not.toContain(listed.evaluation);
            expect(yield* probe(execute, `${step}, again`)).toEqual(listed);
            return listed.evaluation;
          });

        const ownerProfile = (yield* createProfile(actors.owner, path)).id;
        yield* connect(actors.owner, ownerProfile, "alpha");
        const seen: string[] = [];
        seen.push(
          yield* evaluated(owner, "First listing", { version: "first", token: "alpha" }, seen),
        );

        // Another member's profile is listed with that member's own account, and neither
        // profile's listing is served to the other.
        const memberProfile = (yield* createProfile(actors.member, path)).id;
        yield* connect(actors.member, memberProfile, "delta");
        const memberEvaluation = yield* evaluated(
          member,
          "Another member's profile",
          { version: "first", token: "delta" },
          seen,
        );
        expect(yield* probe(owner, "The owner's listing is unchanged")).toEqual({
          version: "first",
          token: "alpha",
          evaluation: seen[0],
        });
        seen.push(memberEvaluation);

        // A new profile revision with the same selection.
        const Profile = Schema.Struct({
          accounts: Schema.Record(
            Schema.String,
            Schema.Union([Schema.String, Schema.Array(Schema.String)]),
          ),
        });
        const current = yield* body(
          Profile,
          yield* api.request(actors.owner, "GET", `${path}/profiles/${ownerProfile}`),
        );
        expect(
          (yield* selectProfileAccounts(actors.owner, path, ownerProfile, current.accounts)).status,
        ).toBe(200);
        seen.push(
          yield* evaluated(
            owner,
            "New profile revision",
            { version: "first", token: "alpha" },
            seen,
          ),
        );

        // A changed account selection. Every selection change also moves the profile revision, so
        // through the product this cannot be told apart from the revision step above.
        yield* connect(actors.owner, ownerProfile, "gamma");
        seen.push(
          yield* evaluated(owner, "Changed selection", { version: "first", token: "gamma" }, seen),
        );

        // A reconnected account: same account, new stored credential.
        yield* reconnect(actors.owner, accounts.at(-1)!.id, "rotated");
        seen.push(
          yield* evaluated(
            owner,
            "Rotated credential",
            { version: "first", token: "rotated" },
            seen,
          ),
        );

        // A new deployment.
        const redeployed = yield* saveAndDeploy(actors.owner, path, {
          files: [{ path: "index.ts", content: probeAppSource("second") }, appsManifest],
        });
        expect(redeployed.status).toBe(200);
        seen.push(
          yield* evaluated(owner, "New deployment", { version: "second", token: "rotated" }, seen),
        );
        // The member's kept listing belongs to the replaced deployment too.
        const memberLatest = yield* evaluated(
          member,
          "New deployment for the member",
          { version: "second", token: "delta" },
          seen,
        );
        seen.push(memberLatest);

        // The dashboard's full listing is the same kept listing MCP discovery reads. One member's
        // second profile with the same account is another listing: the key holds the profile,
        // not only the credential.
        const Listing = Schema.Struct({
          items: Schema.Array(Schema.Struct({ description: Schema.String })),
        });
        const listed = (actor: Session, profile: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actor, "GET", `${path}/tools?profile=${profile}`);
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const { items } = yield* body(Listing, response);
            expect(items).toHaveLength(1);
            const [, version = "", token = "", evaluation = ""] =
              / probe (\w+) token (\w+) evaluation ([0-9a-f-]+)\./.exec(items[0]!.description) ??
              [];
            return { version, token, evaluation };
          });
        const ownerLatest = seen.at(-2)!;
        expect(yield* listed(actors.owner, ownerProfile)).toEqual({
          version: "second",
          token: "rotated",
          evaluation: ownerLatest,
        });
        const secondProfile = (yield* createProfile(actors.owner, path)).id;
        const selected = yield* body(
          Profile,
          yield* api.request(actors.owner, "GET", `${path}/profiles/${ownerProfile}`),
        );
        expect(
          (yield* selectProfileAccounts(actors.owner, path, secondProfile, selected.accounts))
            .status,
        ).toBe(200);
        const second = yield* listed(actors.owner, secondProfile);
        expect(second).toMatchObject({ version: "second", token: "rotated" });
        expect(seen).not.toContain(second.evaluation);
        expect(yield* listed(actors.owner, secondProfile)).toEqual(second);
        expect((yield* listed(actors.owner, ownerProfile)).evaluation).toBe(ownerLatest);

        // Revoking the member's access to the app refuses the member's kept listing at once.
        expect((yield* listed(actors.member, memberProfile)).evaluation).toBe(memberLatest);
        const revision = (yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${path}/access`),
        )).revision;
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision,
            audience: { kind: "private" },
          })).status,
        ).toBe(200);
        const refused = yield* api.request(
          actors.member,
          "GET",
          `${path}/tools?profile=${memberProfile}`,
        );
        expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(refused.body)).not.toContain(memberLatest);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
