/** Controlled product benchmark; all population writes use public hosted APIs. */
import { Clock, Console, Effect, Schema } from "effect";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App, Resource } from "../support/contracts.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Evidence } from "../support/evidence.ts";

const source = `import {defineApp,defineProvider,secrets,defineDatabase,table,query,mutation,object,string,array} from "apps";
const service=defineProvider({name:"Synthetic discovery",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const database=defineDatabase({records:table({key:string(),value:string()})});
export default defineApp({accounts:{service},database},{queries:{
${Array.from({ length: 32 }, (_, i) => `tool${String(i).padStart(2, "0")}:query({description:"Synthetic discovery tool ${i}",input:object({})},async ctx=>({account:ctx.accounts.service.id,value:${i}}))`).join(",\n")},
count:query({input:object({})},async ctx=>({count:(await ctx.db.records.withIndex("by_creation").collect()).length}))
},mutations:{seed:mutation({input:object({records:array(object({key:string(),value:string()}))})},async(ctx,input)=>{for(const row of input.records)await ctx.db.records.insert(row);return {inserted:input.records.length};})}});`;
const Inventory = Schema.Struct({
  apps: Schema.Array(Resource),
  accounts: Schema.Array(Resource),
  profiles: Schema.Array(Resource),
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Boolean, value: Schema.optional(Schema.Unknown) }),
  unavailableApps: Schema.Array(Schema.Struct({ reason: Schema.String })),
});

/** Seed 24 apps, 16 accounts, 24 profiles and 1000 records; sample the 1/8/24-app steps. */
export const discoveryBenchmark = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    evidence = yield* Evidence,
    mcp = yield* McpClient;
  const root = `/api/organizations/${actors.organization.id}`;
  const key = yield* body(
    Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
    yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
      name: "Discovery benchmark",
    }),
  );
  yield* Effect.addFinalizer(() =>
    api
      .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
      .pipe(Effect.orDie),
  );
  const client = yield* mcp.connect(key.key, "discovery-benchmark", {
    organization: actors.organization.id,
  });
  const apps: { id: string; slug: string; profile: string }[] = [];
  const accounts: string[] = [];
  const samples: {
    apps: number;
    trial: string;
    durationMs: number;
    inventoryMs: number;
    inventory: { apps: number; accounts: number; profiles: number };
    ok: boolean;
    unavailable: number;
    value: unknown;
    traceIds: readonly string[];
  }[] = [];
  const requireOk = (status: number) =>
    status === 200 ? Effect.void : Effect.fail(new Error(`Benchmark setup returned ${status}`));
  const measure = (count: number, trial: string) =>
    Effect.gen(function* () {
      const before = (yield* evidence.requests).length;
      const inventoryAt = yield* Clock.currentTimeMillis;
      const response = yield* api.request(actors.owner, "GET", `${root}/inventory`);
      yield* requireOk(response.status);
      const inventory = yield* body(Inventory, response);
      const inventoryMs = (yield* Clock.currentTimeMillis) - inventoryAt;
      const at = yield* Clock.currentTimeMillis;
      const result = yield* client.use(`Discovery ${count} apps ${trial}`, (client, signal) =>
        client.callTool(
          {
            name: "execute",
            arguments: {
              code: 'return {matches: (await tools.search({limit:2000})).items.filter(item => item.description.includes("Synthetic discovery tool")).length};',
            },
          },
          undefined,
          { signal },
        ),
      );
      const durationMs = (yield* Clock.currentTimeMillis) - at;
      const completed = yield* Schema.decodeUnknownEffect(Completed)(result.structuredContent);
      if (completed.execution.ok) {
        const value = yield* Schema.decodeUnknownEffect(Schema.Struct({ matches: Schema.Number }))(
          completed.execution.value,
        );
        if (value.matches !== count * 32)
          return yield* Effect.fail(
            new Error(`Catalog incomplete: expected ${count * 32}, got ${value.matches}`),
          );
      }
      const sample = {
        apps: count,
        trial,
        durationMs,
        inventoryMs,
        inventory: {
          apps: inventory.apps.length,
          accounts: inventory.accounts.length,
          profiles: inventory.profiles.length,
        },
        ok: completed.execution.ok,
        unavailable: completed.unavailableApps.length,
        value: completed.execution.value,
        traceIds: (yield* evidence.requests).slice(before).map((r) => r.traceId),
      };
      samples.push(sample);
      yield* evidence.json("discovery-benchmark.json", {
        shape: { apps: 24, accounts: 16, profiles: 24, records: 1000, toolsPerApp: 34 },
        samples,
      });
      yield* Console.log(JSON.stringify(sample));
    });
  for (let index = 0; index < 24; index++) {
    const response = yield* api.request(actors.owner, "POST", `${root}/apps/deploy`, {
      name: `Discovery ${String(index + 1).padStart(2, "0")}`,
      files: [{ path: "index.ts", content: source }],
    });
    yield* requireOk(response.status);
    const app = yield* body(App, response);
    const appPath = `${root}/apps/${app.id}`;
    const profile = yield* createProfile(actors.owner, appPath);
    if (index === 0) {
      for (let account = 0; account < 16; account++) {
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${appPath}/connections`, {
            profile: profile.id,
            requirement: "service",
            destination: { kind: "shared", audience: { kind: "everyone" } },
          }),
        );
        const saved = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${root}/connections/${connection.id}/submit`, {
            method: "key",
            label: `Synthetic ${String(account + 1).padStart(2, "0")}`,
            fields: { token: `synthetic-discovery-${account}` },
          }),
        );
        accounts.push(saved.id);
      }
    }
    const selected = accounts[index % accounts.length];
    if (selected === undefined) return yield* Effect.fail(new Error("Benchmark account missing"));
    yield* selectProfileAccounts(actors.owner, appPath, profile.id, { service: selected }).pipe(
      Effect.flatMap((response) => requireOk(response.status)),
    );
    apps.push({ id: app.id, slug: app.slug, profile: profile.id });
    if (index === 0) {
      for (let offset = 0; offset < 1000; offset += 100) {
        const seeded = yield* api.request(actors.owner, "POST", `${appPath}/tools/call`, {
          profile: profile.id,
          tool: "mutations.seed",
          input: {
            records: Array.from({ length: 100 }, (_, i) => ({
              key: `record-${offset + i}`,
              value: `Synthetic record ${offset + i}`,
            })),
          },
        });
        yield* requireOk(seeded.status);
        const value = yield* body(Schema.Struct({ inserted: Schema.Number }), seeded);
        if (value.inserted !== 100) return yield* Effect.fail(new Error("Incomplete record seed"));
      }
      const count = yield* body(
        Schema.Struct({ count: Schema.Number }),
        yield* api.request(actors.owner, "POST", `${appPath}/tools/call`, {
          profile: profile.id,
          tool: "queries.count",
          input: {},
        }),
      );
      if (count.count !== 1000) return yield* Effect.fail(new Error("Stored records differ"));
    }
    if ([1, 8, 24].includes(apps.length)) {
      yield* Console.log(
        `Seeded ${apps.length} apps, ${accounts.length} accounts and 1000 records.`,
      );
      for (let trial = 0; trial < 4; trial++)
        yield* measure(apps.length, trial === 0 ? "first" : `warm-${trial}`);
    }
  }
  // Two independent protocol clients model concurrent users without sharing their response stream.
  yield* Effect.forEach(
    [1, 2],
    (trial) =>
      Effect.scoped(
        Effect.gen(function* () {
          const parallel = yield* mcp.connect(key.key, `parallel-${trial}`, {
            organization: actors.organization.id,
          });
          const at = yield* Clock.currentTimeMillis;
          const response = yield* parallel.use(`Concurrent discovery ${trial}`, (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: 'return {matches: (await tools.search({limit:2000})).items.filter(item => item.description.includes("Synthetic discovery tool")).length};',
                },
              },
              undefined,
              { signal },
            ),
          );
          const elapsed = (yield* Clock.currentTimeMillis) - at;
          const result = yield* Schema.decodeUnknownEffect(Completed)(response.structuredContent);
          yield* evidence.json(`discovery-concurrent-${trial}.json`, {
            durationMs: elapsed,
            result,
          });
          yield* Console.log(
            JSON.stringify({ concurrent: trial, durationMs: elapsed, ok: result.execution.ok }),
          );
        }),
      ),
    { concurrency: 2 },
  );
  yield* evidence.json("discovery-population.json", { apps, accounts, records: 1000 });
  yield* evidence.flush;
  return { apps: apps.length, accounts: accounts.length, evidence: evidence.directory };
});
