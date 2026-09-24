/** Persistent app cache and lazy sources through the public deployment/call API. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema, Fiber } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";

const files = [
  {
    path: "index.ts",
    content: `
import { defineApp, defineProvider, secrets, dynamicTools, query, object, string, boolean } from "apps";
const provider=defineProvider({name:"Cache scope",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export default defineApp({ accounts: { service: provider.many() } }, async ctx => ({
  dynamicTools: dynamicTools({
    list: async () => [],
    resolve: async name => name === "queries.lazy" ? query({ input: object({}) }, async () => "resolved-without-list") : undefined,
  }),
  queries: {
    private: query({input:object({id:string()})},async (_, {id})=>ctx.cache.forAccount({id}).get({key:"private",schema:string(),freshFor:"1 minute",load:async()=>crypto.randomUUID()})),
    expired: query({input:object({})},async()=>ctx.cache.get({key:"expired",schema:string(),freshFor:0,load:async()=>crypto.randomUUID()})),
    held: query({input:object({})},async()=>ctx.cache.get({key:"held",schema:string(),freshFor:"1 minute",load:async({cache,signal})=>{
      await cache.write([{key:"held-started",value:true}],"1 minute");
      while(!await cache.read("held-release",boolean())){if(signal.aborted)throw new Error("Cancelled");await new Promise(resolve=>setTimeout(resolve,25));}
      return "old";
    }})),
    heldStarted: query({input:object({})},async()=>await ctx.cache.read("held-started",boolean()) ?? false),
    heldRelease: query({input:object({})},async()=>{await ctx.cache.write([{key:"held-release",value:true}],"1 minute");return true;}),
    replacement: query({input:object({})},async()=>ctx.cache.get({key:"held",schema:string(),freshFor:"1 minute",load:async()=>"replacement"})),
    refresh: query({ input: object({ key: string() }) }, async (_, { key }) => ctx.cache.revalidate({key, schema:string(),freshFor:"1 minute", load:async()=>crypto.randomUUID()})),
    refreshFailed: query({ input: object({ key: string() }) }, async (_, { key }) => ctx.cache.revalidate({key, schema:string(),freshFor:"1 minute",load:async()=>{throw new Error("Synthetic refresh failure");}})),
    cached: query({ input: object({ key: string() }) }, async (_, { key }) => ctx.cache.get({ key, schema: string(), freshFor: "1 minute", load: async () => crypto.randomUUID() })),
    invalidate: query({ input: object({ key: string() }) }, async (_, { key }) => { await ctx.cache.invalidate(key); return true; }),
    seed: query({ input: object({}) }, async () => ctx.cache.get({ key: "swr", schema: string(), freshFor: 0, staleFor: "1 minute", load: async () => "seed" })),
    stale: query({ input: object({}) }, async () => ctx.cache.get({ key: "swr", schema: string(), freshFor: "1 minute", staleFor: "1 minute", load: async ({ cache, signal }) => {
      await cache.write([{ key: "started", value: true }], "1 minute");
      while (!await cache.read("release", boolean())) {
        if (signal.aborted) throw new Error("Refresh cancelled");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return "refreshed";
    } })),
    started: query({ input: object({}) }, async () => await ctx.cache.read("started", boolean()) ?? false),
    release: query({ input: object({}) }, async () => { await ctx.cache.write([{ key: "release", value: true }], "1 minute"); return true; }),
    failed: query({ input: object({}) }, async () => ctx.cache.get({ key: "failure", schema: string(), freshFor: "1 minute", load: async () => { throw new Error("Synthetic failure"); } })),
    recovered: query({ input: object({}) }, async () => ctx.cache.get({ key: "failure", schema: string(), freshFor: "1 minute", load: async () => "recovered" })),
    invalid: query({ input: object({}) }, async () => { await ctx.cache.write([{key:"schema",value:123}], "1 minute"); return ctx.cache.read("schema", string()); }),
  },
}));
`,
  },
];
layer(HostedLive, { excludeTestServices: true })("App caching", (it) => {
  it.effect(scenarios.appCache.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const dynamicOnly = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Dynamic only ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `
import { defineApp, dynamicTools, query, object } from "apps";
export default defineApp({ accounts: {} }, {
  dynamicTools: dynamicTools({
    list: async () => [{ name: "queries.ping", description: "Return pong", inputSchema: { type: "object", properties: {} }, readOnly: true }],
    resolve: async name => name === "queries.ping" ? query({ input: object({}) }, async () => "pong") : undefined,
  }),
});
`,
            },
          ],
        });
        expect(dynamicOnly.status).toBe(200);
        const dynamicPath = `${prefix}/${(yield* body(App, dynamicOnly)).id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", dynamicPath).pipe(Effect.orDie),
        );
        const dynamicProfile = yield* createProfile(actors.owner, dynamicPath);
        const dynamicResult = yield* api.request(
          actors.owner,
          "POST",
          `${dynamicPath}/tools/call`,
          {
            profile: dynamicProfile.id,
            tool: "queries.ping",
            input: {},
          },
        );
        expect(dynamicResult.status).toBe(200);
        expect(yield* body(Schema.String, dynamicResult)).toBe("pong");

        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Cache ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status).toBe(200);
        const app = (yield* body(App, deployed)).id;
        const path = `${prefix}/${app}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const first = yield* createProfile(actors.owner, path);
        const second = yield* createProfile(actors.owner, path);
        expect(
          (yield* selectProfileAccounts(actors.owner, path, first.id, { service: [] })).status,
        ).toBe(200);
        expect(
          (yield* selectProfileAccounts(actors.owner, path, second.id, { service: [] })).status,
        ).toBe(200);
        const request = (name: string, input: Schema.Json = {}, profile = first.id) =>
          api.request(actors.owner, "POST", `${path}/tools/call`, {
            profile,
            tool: `queries.${name}`,
            input,
          });
        const call = (name: string, input: Schema.Json = {}, profile = first.id) =>
          Effect.gen(function* () {
            const response = yield* request(name, input, profile);
            expect(response.status, name).toBe(200);
            return yield* body(Schema.Json, response);
          });
        const accountIds: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(accountIds, (id) =>
            api.request(
              actors.owner,
              "DELETE",
              `/api/organizations/${actors.organization.id}/accounts/${id}`,
            ),
          ).pipe(Effect.orDie),
        );
        const submit = (id: string, token: string) =>
          api.request(
            actors.owner,
            "POST",
            `/api/organizations/${actors.organization.id}/connections/${id}/submit`,
            { method: "key", label: "Synthetic cache scope", fields: { token } },
          );
        for (const token of ["synthetic-cache-a", "synthetic-cache-b"]) {
          const connection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${path}/connections`, {
              requirement: "service",
              profile: first.id,
            }),
          );
          const account = yield* body(Resource, yield* submit(connection.id, token));
          accountIds.push(account.id);
        }
        const [one, two] = accountIds;
        if (one === undefined || two === undefined)
          return yield* Effect.die("Expected two accounts");
        const privateValue = yield* call("private", { id: one });
        expect(yield* call("private", { id: one })).toBe(privateValue);
        expect(yield* call("private", { id: two })).not.toBe(privateValue);
        const reconnect = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            `/api/organizations/${actors.organization.id}/accounts/${one}/connections`,
          ),
        );
        expect((yield* submit(reconnect.id, "synthetic-rotated")).status).toBe(200);
        expect(yield* call("private", { id: one })).not.toBe(privateValue);
        expect((yield* request("private", { id: two }, second.id)).status).toBeGreaterThanOrEqual(
          400,
        );
        expect(yield* call("expired")).not.toBe(yield* call("expired"));
        expect(yield* call("lazy")).toBe("resolved-without-list");
        const warm = yield* call("cached", { key: "shared" });
        expect(yield* call("cached", { key: "shared" }, second.id)).toBe(warm);
        const refreshedValue = yield* call("refresh", { key: "refresh-check" });
        expect(yield* call("cached", { key: "refresh-check" })).toBe(refreshedValue);
        const nextValue = yield* call("refresh", { key: "refresh-check" });
        expect(nextValue).not.toBe(refreshedValue);
        expect(
          (yield* request("refreshFailed", { key: "refresh-check" })).status,
        ).toBeGreaterThanOrEqual(400);
        expect(yield* call("cached", { key: "refresh-check" })).toBe(nextValue);
        const burst = yield* Effect.all(
          Array.from({ length: 6 }, () => call("cached", { key: "concurrent" })),
          { concurrency: 6 },
        );
        expect(new Set(burst).size).toBe(1);
        yield* call("invalidate", { key: "shared" });
        expect(yield* call("cached", { key: "shared" })).not.toBe(warm);
        expect((yield* request("failed")).status).toBeGreaterThanOrEqual(400);
        expect(yield* call("recovered")).toBe("recovered");
        expect((yield* request("invalid")).status).toBeGreaterThanOrEqual(400);
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
