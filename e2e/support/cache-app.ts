/** A fresh deployed app and profiles for each cache scenario. */
import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "./api.ts";
import { Actors } from "./actors.ts";
import { App } from "./contracts.ts";
import { createProfile, selectProfileAccounts } from "./profiles.ts";

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
export const cacheApp = Effect.gen(function* () {
  const api = yield* Api;
  const actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}/apps`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
    name: `Cache ${randomUUID().slice(0, 8)}`,
    files,
  });
  expect(deployed.status).toBe(200);
  const app = (yield* body(App, deployed)).id;
  const path = `${prefix}/${app}`;
  yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));
  const first = yield* createProfile(actors.owner, path);
  const second = yield* createProfile(actors.owner, path);
  expect((yield* selectProfileAccounts(actors.owner, path, first.id, { service: [] })).status).toBe(
    200,
  );
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
  return { api, actors, path, first, second, request, call };
});
