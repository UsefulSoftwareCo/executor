/** Cache pressure and diagnostics through an authored app's real host transport. */
import { expect, layer } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { App } from "../support/contracts.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { appsManifest, mcpSdkVersion, withApps } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";

const fixture = ({ upstream, hold }: { readonly upstream?: string; readonly hold?: string } = {}) =>
  Effect.gen(function* () {
    const actors = yield* Actors;
    const api = yield* Api;
    const prefix = `/api/organizations/${actors.organization.id}/apps`;
    const files = [
      {
        path: "index.ts",
        content: `import { CacheError, defineApp, query, object, string, number, boolean, router } from "apps";
${upstream === undefined ? "" : 'import { mcpRouter } from "apps/mcp";'}
export default defineApp({ accounts: {} }, async ({ cache }) => ({ tools: router({
  ${upstream === undefined ? "" : `upstream: await mcpRouter({ url: ${JSON.stringify(upstream)}, cache }),`}
  diagnostic: query({ input: object({ read: number() }) }, async (_, { read }) => {
    try {
      if (read === 1) await cache.readMany(Array.from({ length: 129 }, (_, i) => i), string());
      else if (read === 2) await cache.write([{ key: "SYNTHETIC_PRIVATE_CACHE_KEY" + "x".repeat(9000), value: true }], "1 minute");
      else if (read === 3) await cache.write(Array.from({ length: 4 }, (_, i) => ({ key: "batch-" + i, value: "x".repeat(1999990) })), "1 minute");
      else if (read === 4) await cache.write([{ key: "atomic", value: "kept" }], "8 days");
      else if (read === 5) await cache.write(Array.from({ length: 129 }, (_, i) => ({ key: "count-" + i, value: true })), "1 minute");
      else await cache.write([{ key: "atomic", value: "kept" }, { key: "SYNTHETIC_PRIVATE_CACHE_KEY", value: "SYNTHETIC_PRIVATE_CACHE_VALUE" + "x".repeat(2000000) }], "1 minute");
      return null;
    } catch (error) {
      if (!(error instanceof CacheError)) throw error;
      return { reason: error.reason, message: error.message, atomic: await cache.read("atomic", string()) === undefined };
    }
  }),
  held: query({ input: object({}) }, async () => cache.get({ key: "held", schema: string(), freshFor: "1 minute", load: async ({ cache, signal }) => {
    await cache.write([{ key: "held-started", value: true }], "1 day");
    while (!await cache.read("held-release", boolean())) {
      if (signal.aborted) throw new Error("Cancelled");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return "held";
  } })),
  heldStarted: query({ input: object({}) }, async () => await cache.read("held-started", boolean()) ?? false),
  heldRelease: query({ input: object({}) }, async () => { await cache.write([{ key: "held-release", value: true }], "1 minute"); return true; }),
  ${
    hold === undefined
      ? ""
      : `holdValues: query({ input: object({}) }, async () => {
    await Promise.all(Array.from({ length: 67 }, (_, i) => cache.revalidate({ key: "pressure-" + i, schema: string(), freshFor: "1 day", load: async ({ signal }) => {
      const response = await fetch(${JSON.stringify(hold)}, { signal });
      if (!response.ok) throw new Error("Loader hold failed");
      return "refreshed";
    } }).then(() => true)));
    return true;
  }),`
  }
  blockedWrite: query({ input: object({}) }, async () => {
    try {
      await cache.write([{ key: "pressure-66", value: "r".repeat(1900000) }, { key: "blocked-write", value: "x".repeat(1900000) }], "1 day");
      return null;
    } catch (error) {
      if (!(error instanceof CacheError)) throw error;
      return { reason: error.reason, message: error.message, absent: await cache.read("blocked-write", string()) === undefined, kept: (await cache.read("pressure-66", string()))?.startsWith("x") ?? false };
    }
  }),
  countFill: query({ input: object({ start: number(), count: number() }) }, async (_, { start, count }) => {
    for (let i = 0; i < count; i += 128) await cache.write(Array.from({ length: Math.min(128, count - i) }, (_, j) => ({ key: "entry-" + (start + i + j), value: "kept" })), "1 day");
    return true;
  }),
  fill: query({ input: object({ batch: number() }) }, async (_, { batch }) => {
    await cache.write(Array.from({ length: 4 }, (_, i) => ({ key: "pressure-" + (batch * 4 + i), value: "x".repeat(1900000) })), "1 day");
    return true;
  }),
  size: query({ input: object({ key: string() }) }, async (_, { key }) => (await cache.read(key, string()))?.length ?? null),
  replace: query({ input: object({ key: string(), size: number() }) }, async (_, { key, size }) => {
    await cache.write([{ key, value: "x".repeat(size) }], "1 day");
    return true;
  }),
  load: query({ input: object({}) }, async () => cache.get({ key: "loaded", schema: string(), freshFor: "1 minute", load: async () => "loaded" })),
}) }));`,
      },
      upstream === undefined
        ? appsManifest
        : {
            path: "package.json",
            content: JSON.stringify({
              dependencies: withApps({ "@modelcontextprotocol/sdk": mcpSdkVersion }),
            }),
          },
    ];
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
      name: `Cache capacity ${randomUUID().slice(0, 8)}`,
      files,
    });
    expect(deployed.status).toBe(200);
    const app = (yield* body(App, deployed)).id;
    const path = `${prefix}/${app}`;
    yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));
    const request = (tool: string, input: Schema.Json = {}) =>
      api.request(actors.owner, "POST", `${path}/tools/call`, { tool, kind: "query", input });
    const call = (tool: string, input: Schema.Json = {}) =>
      Effect.gen(function* () {
        const response = yield* request(tool, input);
        expect(response.status, `${tool} ${JSON.stringify(input)}`).toBe(200);
        return yield* body(Schema.Json, response);
      });
    const redeploy = () =>
      saveAndDeploy(actors.owner, path, {
        files: files.map((file) =>
          file.path === "index.ts"
            ? {
                ...file,
                content: `${file.content}\n// A distinct build with the same cache keys.\n`,
              }
            : file,
        ),
      });
    return {
      request,
      call,
      redeploy,
      index: () => api.request(actors.owner, "GET", `${path}/tools/index`),
    };
  });

const loaderServer = Effect.gen(function* () {
  const released = yield* Deferred.make<void>();
  let started = 0;
  const handler = Effect.gen(function* () {
    started++;
    yield* Deferred.await(released);
    return HttpServerResponse.empty();
  });
  const services = yield* Layer.build(
    HttpRouter.serve(HttpRouter.add("GET", "/hold", handler), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Expected a TCP listener");
  return {
    url: `http://127.0.0.1:${server.address.port}/hold`,
    started: () => started,
    release: Deferred.succeed(released, undefined),
  };
});

const catalogServer = Effect.gen(function* () {
  let lists = 0;
  const Rpc = Schema.Struct({ id: Schema.optional(Schema.Number), method: Schema.String });
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rpc = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Rpc)));
    if (rpc.id === undefined) return HttpServerResponse.empty({ status: 202 });
    let result: Schema.Json = {};
    switch (rpc.method) {
      case "initialize":
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "pressure", version: "1" },
        };
        break;
      case "tools/list":
        lists++;
        // Full tool parts and pages exceed one reclamation batch, so pressure can remove
        // older parts while leaving the later manifest and schema-free summaries intact.
        result = {
          tools: Array.from({ length: 12 }, (_, i) => ({
            name: `fixture_${i}`,
            inputSchema: { type: "object", properties: {}, description: "x".repeat(900_000) },
            annotations: { readOnlyHint: true },
          })),
        };
        break;
      case "tools/call":
        result = { content: [{ type: "text", text: "pressure-receipt" }] };
        break;
    }
    return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: rpc.id, result });
  }).pipe(Effect.orDie);
  const services = yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add("POST", "/mcp", handler),
        HttpRouter.add("GET", "/mcp", Effect.succeed(HttpServerResponse.empty({ status: 405 }))),
        HttpRouter.add("DELETE", "/mcp", Effect.succeed(HttpServerResponse.empty({ status: 204 }))),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Expected a TCP listener");
  return { url: `http://127.0.0.1:${server.address.port}/mcp`, lists: () => lists };
});

layer(HostedLive, { excludeTestServices: true })("App caching", (it) => {
  it.effect(scenarios.appCacheReasons.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { call } = yield* fixture();
        for (const read of [0, 1, 2, 3, 4, 5]) {
          const diagnostic = yield* call("diagnostic", { read });
          const reason = read === 4 ? "invalid" : "capacity";
          expect(diagnostic).toEqual({ reason, message: `CacheError: ${reason}`, atomic: true });
          expect(JSON.stringify(diagnostic)).not.toContain("SYNTHETIC_PRIVATE_CACHE");
        }
      }),
    ),
  );

  it.effect(scenarios.appCacheEntryCapacity.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { call, redeploy } = yield* fixture();
        expect(yield* call("countFill", { start: 0, count: 100_000 })).toBe(true);
        expect(yield* call("size", { key: "entry-0" })).toBe(4);
        expect(yield* call("countFill", { start: 100_000, count: 128 })).toBe(true);
        expect(yield* call("size", { key: "entry-0" })).toBeNull();
        expect(yield* call("size", { key: "entry-100127" })).toBe(4);
        expect(yield* call("load")).toBe("loaded");
        expect(yield* call("countFill", { start: 100_128, count: 128 })).toBe(true);
        expect(yield* call("load")).toBe("loaded");
        const rebuilt = yield* redeploy();
        expect(rebuilt.status, JSON.stringify(rebuilt.body)).toBe(200);
        // Builds share the store's limit, but never each other's values. Old-build rows
        // must be eligible victims when a new namespace reaches aggregate capacity.
        expect(yield* call("size", { key: "entry-100127" })).toBeNull();
        expect(yield* call("countFill", { start: 0, count: 512 })).toBe(true);
        expect(yield* call("size", { key: "entry-0" })).toBe(4);
        expect(yield* call("size", { key: "entry-511" })).toBe(4);
        expect(yield* call("load")).toBe("loaded");
      }),
    ),
  );

  it.effect(scenarios.appCacheCatalogCapacity.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const server = yield* catalogServer;
        const { call, index } = yield* fixture({ upstream: server.url });
        expect((yield* index()).status).toBe(200);
        expect(server.lists()).toBe(1);
        for (let batch = 0; batch < 14; batch++) expect(yield* call("fill", { batch })).toBe(true);
        // Summaries remain readable, but the first tool's full metadata was older and evicted.
        expect((yield* index()).status).toBe(200);
        expect(server.lists()).toBe(1);
        expect(JSON.stringify(yield* call("upstream.fixture_0"))).toContain("pressure-receipt");
        expect(server.lists()).toBeGreaterThan(1);
        expect((yield* index()).status).toBe(200);
        expect(JSON.stringify(yield* call("upstream.fixture_0"))).toContain("pressure-receipt");
      }),
    ),
  );

  it.effect(scenarios.appCacheProtectedCapacity.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const server = yield* loaderServer;
        const { call, request } = yield* fixture({ hold: server.url });
        for (let batch = 0; batch < 16; batch++) expect(yield* call("fill", { batch })).toBe(true);
        for (let key = 64; key < 67; key++)
          expect(yield* call("replace", { key: `pressure-${key}`, size: 1_900_000 })).toBe(true);
        const holder = yield* request("holdValues").pipe(Effect.forkScoped);
        yield* Effect.sync(server.started).pipe(
          Effect.repeat({ until: (count) => count === 67 }),
          Effect.timeout("10 seconds"),
        );
        // Every retained value now has a live lease. A valid batch cannot fit, and its
        // replacement must restore both the old value and the loader's publication fence.
        expect(yield* call("blockedWrite")).toEqual({
          reason: "capacity",
          message: "CacheError: capacity",
          absent: true,
          kept: true,
        });
        expect(yield* call("size", { key: "pressure-0" })).toBe(1_900_000);
        yield* server.release;
        const published = yield* Fiber.join(holder).pipe(Effect.timeout("10 seconds"));
        expect(published.status).toBe(200);
        expect(yield* body(Schema.Json, published)).toBe(true);
        expect(yield* call("size", { key: "pressure-66" })).toBe(9);
        expect(yield* call("replace", { key: "blocked-write", size: 1_900_000 })).toBe(true);
        expect(yield* call("size", { key: "blocked-write" })).toBe(1_900_000);
        expect(yield* call("load")).toBe("loaded");
      }),
    ),
  );

  it.effect(scenarios.appCacheCapacity.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { call, request } = yield* fixture();
        const held = yield* request("held").pipe(Effect.forkScoped);
        yield* call("heldStarted").pipe(
          Effect.repeat({ until: (value) => value === true }),
          Effect.timeout("10 seconds"),
        );
        // Each batch is below 8 MB and each entry below 2 MB. Retention is still a day away.
        for (let batch = 0; batch < 16; batch++) expect(yield* call("fill", { batch })).toBe(true);
        expect(yield* call("replace", { key: "pressure-63", size: 1 })).toBe(true);
        expect(yield* call("fill", { batch: 16 })).toBe(true);
        // Replacements count their byte delta, not the whole new value.
        expect(yield* call("size", { key: "pressure-0" })).toBe(1_900_000);
        expect(yield* call("replace", { key: "pressure-63", size: 1_900_000 })).toBe(true);
        expect(yield* call("size", { key: "pressure-0" })).toBeNull();
        expect(yield* call("size", { key: "pressure-63" })).toBe(1_900_000);
        expect(yield* call("heldRelease")).toBe(true);
        const published = yield* Fiber.join(held).pipe(Effect.timeout("10 seconds"));
        expect(published.status).toBe(200);
        expect(yield* body(Schema.Json, published)).toBe("held");
        expect(yield* call("held")).toBe("held");
        expect(yield* call("load")).toBe("loaded");
        for (let batch = 17; batch < 20; batch++) {
          expect(yield* call("fill", { batch })).toBe(true);
          expect(yield* call("size", { key: `pressure-${batch * 4 + 3}` })).toBe(1_900_000);
          expect(yield* call("load")).toBe("loaded");
        }
        expect(yield* call("diagnostic", { read: 0 })).toEqual({
          reason: "capacity",
          message: "CacheError: capacity",
          atomic: true,
        });
      }),
    ),
  );
});
