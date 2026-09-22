import { McpClient } from "../support/mcp-client.ts";
/** Profile behavior through the real SDK HTTP surface and embedded workflow engine. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

const Profile = Schema.Struct({
  id: Schema.String,
  app: Schema.String,
  name: Schema.NullOr(Schema.String),
  revision: Schema.Number,
  enabled: Schema.Boolean,
  status: Schema.String,
  accounts: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  ),
});
const Hooks = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    profile: Schema.NullOr(Schema.String),
    sourceAccount: Schema.String,
    status: Schema.String,
    callbackUrl: Schema.String,
  }),
);
const Deployed = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    activeDeployment: Schema.String,
    slug: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({ mail: Schema.Struct({ provider: Schema.String }) }),
    }),
  }),
});
const Completed = Schema.Struct({ status: Schema.Literal("completed"), value: Schema.Json });
const files = [
  {
    path: "index.ts",
    content: `
import { defineApp, defineProvider, secrets, object, string, query, mutation, workflow, defineDatabase, table, interval } from "apps";
const service = defineProvider({ name: "Profile fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
const database = defineDatabase({ rows: table({ account: string(), body: string() }).index("by_account", ["account"]), registrations: table({ subscription: string(), context: string(), source: string() }).index("by_subscription", ["subscription"]) });
const shape = ctx => ({ auth: "auth" in ctx, profile: "profile" in ctx });
const write = mutation({ input: object({ body: string() }) }, async (ctx, input) => { await ctx.db.rows.insert({ account: ctx.accounts.sink.id, body: input.body }); return ctx.accounts.sink.id; });
const inspect = query({ input: object({}) }, async (ctx) => ({ context: shape(ctx), mail: ctx.accounts.mail.map(a => a.id), sink: ctx.accounts.sink.id, registrations: await ctx.db.registrations.withIndex("by_creation").collect(), totalRows: await ctx.db.rows.withIndex("by_creation").count() }));
const capture = workflow({ input: object({ source: string() }) }, async (ctx, input) => {
 await ctx.step.sleep("before snapshot", "1 second");
 return ctx.step.do("read bindings", async step => ({ context: shape(step), mail: step.accounts.mail.map(a => a.id), sink: step.accounts.sink.id, source: input.source }));
});
const mark = mutation({ input: object({ key: string() }) }, async (ctx, input) => { return await ctx.db.registrations.insert({ subscription: input.key, context: JSON.stringify(shape(ctx)), source: ctx.accounts.sink.id }); });
const pauseable = workflow({ input: object({}) }, async ctx => { await ctx.step.runMutation("started", mark, { key: ctx.runId }); await ctx.step.sleep("wait", "5 minutes"); return "finished"; });
const empty = object({});
const incoming = { account: "mail", config: empty, state: empty,
 register: async (ctx, { account, subscriptionId }) => {
   const found = await ctx.db.registrations.withIndex("by_subscription", q => q.eq("subscription", subscriptionId)).first();
   if (!found) await ctx.db.registrations.insert({ subscription: subscriptionId, context: JSON.stringify(shape(ctx)), source: account.id });
   return {};
 },
 handle: async (ctx, { account, request }) => {
   if (request.headers.get("x-fixture-signature") !== "profile-proof") return new Response(null, { status: 401 });
   const event = await request.json();
   const run = await ctx.workflows.start({ workflow: "capture", input: { source: account.id }, key: event.id });
   return Response.json({ run: run.id });
 },
 unregister: async (ctx, { subscriptionId }) => {
   const found = await ctx.db.registrations.withIndex("by_subscription", q => q.eq("subscription", subscriptionId)).first();
   if (found) await ctx.db.registrations.delete(found.id);
 }
};
export default defineApp({ accounts: { mail: service.many(), sink: service }, database }, { queries: { inspect }, mutations: { write, mark }, workflows: { capture, pauseable }, webhooks: { incoming }, schedules: { summary: interval({ minutes: 1 }, write, { body: "scheduled" }) } });
`,
  },
];

layer(TestLive, { excludeTestServices: true })("Profiles", (it) => {
  it.effect(scenarios.profiles.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          session = yield* api.session();
        const agent: Session = {
          ...session,
          send: (method, path, data, headers = {}) => {
            const { origin: _origin, ...rest } = headers;
            return session.send(method, path, data, {
              ...rest,
              authorization: `Bearer ${Redacted.value(target.apiKey)}`,
            });
          },
        };
        const owner = `profiles-${randomUUID()}`;
        const deployment = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner,
          name: "Profile fixture",
          files,
        });
        expect(deployment.status, JSON.stringify(deployment.body)).toBe(200);
        const { app } = yield* body(Deployed, deployment);
        const path = `/v1/apps/${app.id}`;
        const accounts: string[] = [],
          profiles: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const profile of profiles)
              yield* api.request(agent, "DELETE", `${path}/profiles/${profile}`);
            yield* api.request(agent, "DELETE", path);
            for (const account of accounts)
              yield* api.request(agent, "DELETE", `/v1/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        for (const label of ["mail-a", "mail-b", "sink-a", "sink-b"]) {
          const account = yield* api.request(agent, "POST", "/v1/accounts", {
            owner,
            provider: app.requirements.accounts.mail.provider,
            method: "key",
            label,
            fields: { token: label },
          });
          expect(account.status).toBe(200);
          accounts.push((yield* body(Resource, account)).id);
        }
        const [mailA, mailB, sinkA, sinkB] = accounts;
        if (!mailA || !mailB || !sinkA || !sinkB)
          return yield* Effect.die(new Error("Missing fixture account"));
        const aliceInput = {
          owner,
          subject: "alice",
          name: "Work",
          accounts: { mail: [mailA, mailB], sink: sinkA },
          idempotencyKey: "alice-setup",
        };
        const creation = yield* Effect.all(
          [1, 2].map(() => api.request(agent, "POST", `${path}/profiles`, aliceInput)),
          { concurrency: 2 },
        );
        for (const result of creation) expect(result.status, JSON.stringify(result.body)).toBe(200);
        const first = creation[0],
          repeated = creation[1];
        if (!first || !repeated) return yield* Effect.die(new Error("Missing creation result"));
        const alice = yield* body(Profile, first);
        profiles.push(alice.id);
        expect(alice.name).toBe("Work");
        expect(
          (yield* body(Profile, yield* api.request(agent, "GET", `${path}/profiles/${alice.id}`)))
            .name,
        ).toBe("Work");
        expect(
          (yield* api.request(agent, "POST", `${path}/profiles`, {
            ...aliceInput,
            name: "Personal",
          })).status,
        ).toBe(409);
        expect((yield* body(Profile, repeated)).id).toBe(alice.id);
        expect(
          (yield* api.request(agent, "POST", `${path}/profiles`, {
            ...aliceInput,
            accounts: { mail: [mailA], sink: sinkA },
          })).status,
        ).toBe(409);
        const bob = yield* body(
          Profile,
          yield* api.request(agent, "POST", `${path}/profiles`, {
            owner,
            subject: "bob",
            accounts: { mail: [mailB], sink: sinkB },
            idempotencyKey: "bob-setup",
          }),
        );
        profiles.push(bob.id);
        expect(bob.name).toBeNull();
        const ready = (id: string) =>
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + 40000;
            for (;;) {
              const result = yield* api.request(agent, "POST", `${path}/profiles/${id}/reconcile`);
              expect(result.status, JSON.stringify(result.body)).toBe(200);
              const value = yield* body(Profile, result);
              if (value.status === "ready") return value;
              expect(value.status).not.toBe("failed");
              expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
              yield* Effect.sleep("200 millis");
            }
          });
        yield* ready(alice.id);
        yield* ready(bob.id);
        const hooks = yield* body(Hooks, yield* api.request(agent, "GET", `${path}/webhooks`));
        expect(hooks.filter((h) => h.profile === alice.id && h.status === "active").length).toBe(2);
        expect(hooks.filter((h) => h.profile === bob.id && h.status === "active").length).toBe(1);
        yield* ready(alice.id);
        expect(
          (yield* body(Hooks, yield* api.request(agent, "GET", `${path}/webhooks`))).length,
        ).toBe(3);
        const call = (profile: string, tool: string, input = {}) =>
          api.request(agent, "POST", "/v1/tools/call", { app: app.id, profile, tool, input });
        expect((yield* call(alice.id, "mutations.write", { body: "alice" })).status).toBe(200);
        expect((yield* call(bob.id, "mutations.write", { body: "bob" })).status).toBe(200);
        const identity = yield* body(Completed, yield* call(alice.id, "queries.inspect"));
        expect(identity.value).toMatchObject({
          context: { auth: false, profile: false },
          mail: [mailA, mailB],
          sink: sinkA,
          totalRows: 2,
        });
        const contexts = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            registrations: Schema.Array(
              Schema.Struct({
                context: Schema.fromJsonString(
                  Schema.Struct({ auth: Schema.Boolean, profile: Schema.Boolean }),
                ),
              }),
            ),
          }),
        )(identity.value);
        expect(contexts.registrations.length).toBe(3);
        for (const registration of contexts.registrations)
          expect(registration.context).toEqual({ auth: false, profile: false });
        const associated = yield* api.request(
          agent,
          "GET",
          `/v1/apps?owner=${owner}&account=${mailB}`,
        );
        expect(associated.status).toBe(200);
        expect((yield* body(Schema.Array(Resource), associated)).map((item) => item.id)).toEqual([
          app.id,
        ]);
        expect(
          (yield* api.request(agent, "PATCH", path, { accounts: { sink: sinkA } })).status,
        ).toBe(422);
        const mcp = yield* McpClient;
        const client = yield* mcp.connect(target.apiKey, "profile-targets");
        const discovery = yield* client.use(
          "Discover each account context under the real app",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return tools.search({namespace:${JSON.stringify(app.slug)},limit:100});`,
                },
              },
              undefined,
              { signal },
            ),
        );
        const found = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            execution: Schema.Struct({
              ok: Schema.Literal(true),
              value: Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) }),
            }),
          }),
        )(discovery.structuredContent);
        expect(
          found.execution.value.items.filter((item) => item.path.includes(alice.id)).length,
        ).toBeGreaterThan(0);
        expect(
          found.execution.value.items.filter((item) => item.path.includes(bob.id)).length,
        ).toBeGreaterThan(0);
        const invoked = yield* client.use(
          "Run both scalar account contexts through MCP",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return [await tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(alice.id)}].queries.inspect({}),await tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(bob.id)}].queries.inspect({})];`,
                },
              },
              undefined,
              { signal },
            ),
        );
        const result = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            execution: Schema.Struct({
              ok: Schema.Literal(true),
              value: Schema.Array(
                Schema.Struct({
                  context: Schema.Struct({ auth: Schema.Boolean, profile: Schema.Boolean }),
                  sink: Schema.String,
                }),
              ),
            }),
          }),
        )(invoked.structuredContent);
        expect(result.execution.value).toEqual([
          { context: { auth: false, profile: false }, sink: sinkA },
          { context: { auth: false, profile: false }, sink: sinkB },
        ]);
        const hook = hooks.find((h) => h.profile === alice.id && h.sourceAccount === mailA);
        if (!hook) return yield* Effect.die(new Error("Missing account subscription"));
        const delivered = yield* api.request(
          session,
          "POST",
          new URL(hook.callbackUrl).pathname,
          { id: "message-one" },
          { "x-fixture-signature": "profile-proof" },
        );
        expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
        const run = (yield* body(Schema.Struct({ run: Schema.String }), delivered)).run;
        const changed = yield* api.request(agent, "PATCH", `${path}/profiles/${alice.id}`, {
          expectedRevision: alice.revision,
          accounts: { mail: [mailA], sink: sinkB },
        });
        expect(changed.status).toBe(200);
        expect(
          (yield* api.request(agent, "POST", "/v1/tools/call", {
            app: app.id,
            profile: alice.id,
            expectedProfileRevision: alice.revision,
            tool: "queries.inspect",
            input: {},
          })).status,
        ).toBe(409);
        expect(
          (yield* api.request(agent, "POST", `${path}/workflow-runs`, {
            profile: alice.id,
            expectedProfileRevision: alice.revision,
            deployment: app.activeDeployment,
            workflow: "capture",
            input: { source: "stale form" },
          })).status,
        ).toBe(409);
        const deadline = (yield* Clock.currentTimeMillis) + 40000;
        for (;;) {
          const response = yield* api.request(agent, "GET", `${path}/workflow-runs/${run}`);
          expect(response.status).toBe(200);
          const state = yield* body(
            Schema.Struct({
              status: Schema.String,
              profile: Schema.String,
              output: Schema.optional(Schema.Json),
            }),
            response,
          );
          expect(state.profile).toBe(alice.id);
          if (state.status === "complete") {
            expect(state.output).toEqual({
              context: { auth: false, profile: false },
              mail: [mailA, mailB],
              sink: sinkA,
              source: mailA,
            });
            break;
          }
          expect(state.status).not.toBe("errored");
          expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
          yield* Effect.sleep("200 millis");
        }
        yield* ready(alice.id);
        const updatedHooks = yield* body(
          Hooks,
          yield* api.request(agent, "GET", `${path}/webhooks`),
        );
        expect(
          updatedHooks.filter((h) => h.profile === alice.id && h.status === "active").length,
        ).toBe(1);
        expect(updatedHooks.find((h) => h.id === hook.id)?.status).toBe("stopped");
        const schedules = yield* api.request(agent, "GET", `${path}/schedules?profile=${bob.id}`);
        expect(schedules.status).toBe(200);
        expect(
          yield* body(
            Schema.Array(Schema.Struct({ profile: Schema.String, enabled: Schema.Boolean })),
            schedules,
          ),
        ).toEqual([{ profile: bob.id, enabled: false }]);
        const configured = yield* api.request(agent, "PATCH", `${path}/schedules/summary`, {
          profile: bob.id,
          actor: "bob",
          enabled: true,
        });
        expect(configured.status, JSON.stringify(configured.body)).toBe(200);
        expect(
          (yield* api.request(agent, "POST", `${path}/schedules/summary/run`, {
            profile: bob.id,
          })).status,
        ).toBe(200);
        const scheduledDeadline = (yield* Clock.currentTimeMillis) + 30000;
        for (;;) {
          const rows = yield* body(
            Schema.Array(Schema.Struct({ status: Schema.String, profile: Schema.String })),
            yield* api.request(agent, "GET", `/v1/scheduled-runs?app=${app.id}&profile=${bob.id}`),
          );
          if (rows.some((row) => row.status === "succeeded")) {
            expect(rows.every((row) => row.profile === bob.id)).toBe(true);
            break;
          }
          expect(rows.some((row) => row.status === "failed")).toBe(false);
          expect(yield* Clock.currentTimeMillis).toBeLessThan(scheduledDeadline);
          yield* Effect.sleep("200 millis");
        }
        const newer = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner,
          app: app.id,
          files: files.map((file) => ({
            ...file,
            content: file.content.replace("totalRows:", 'version: "two", totalRows:'),
          })),
        });
        expect(newer.status, JSON.stringify(newer.body)).toBe(200);
        const activated = yield* body(Deployed, newer);
        expect(activated.app.id).toBe(app.id);
        expect(activated.app.activeDeployment).not.toBe(app.activeDeployment);
        expect(
          (yield* body(Completed, yield* call(bob.id, "queries.inspect"))).value,
        ).toMatchObject({ version: "two", sink: sinkB, totalRows: 3 });
        expect(
          (yield* body(Completed, yield* call(alice.id, "queries.inspect"))).value,
        ).toMatchObject({ version: "two", sink: sinkB });
        for (const profile of [alice.id, bob.id]) {
          const setupDeadline = (yield* Clock.currentTimeMillis) + 30000;
          for (;;) {
            const response = yield* api.request(
              agent,
              "POST",
              `${path}/profiles/${profile}/reconcile`,
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const ready = yield* body(Profile, response);
            if (ready.status === "ready") break;
            expect(ready.status).toBe("pending");
            expect(yield* Clock.currentTimeMillis).toBeLessThan(setupDeadline);
            yield* Effect.sleep("200 millis");
          }
        }
        const beforePause = yield* body(
          Profile,
          yield* api.request(agent, "GET", `${path}/profiles/${bob.id}`),
        );
        const waiting = yield* body(
          Resource,
          yield* api.request(agent, "POST", `${path}/workflow-runs`, {
            profile: bob.id,
            workflow: "pauseable",
            input: {},
            key: "pause-running-work",
          }),
        );
        const sleepDeadline = (yield* Clock.currentTimeMillis) + 15000;
        for (;;) {
          const response = yield* body(Completed, yield* call(bob.id, "queries.inspect"));
          const markers = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              registrations: Schema.Array(Schema.Struct({ subscription: Schema.String })),
            }),
          )(response.value);
          if (markers.registrations.some((item) => item.subscription === waiting.id)) break;
          const execution = yield* api.request(agent, "GET", `${path}/workflow-runs/${waiting.id}`);
          expect(execution.body, JSON.stringify(execution.body)).not.toMatchObject({
            status: "errored",
          });
          expect(yield* Clock.currentTimeMillis).toBeLessThan(sleepDeadline);
          yield* Effect.sleep("100 millis");
        }
        expect(
          (yield* api.request(agent, "GET", `${path}/workflow-runs/${waiting.id}`)).body,
        ).toMatchObject({ status: "running" });
        const paused = yield* body(
          Profile,
          yield* api.request(agent, "PATCH", `${path}/profiles/${bob.id}/enabled`, {
            expectedRevision: beforePause.revision,
            enabled: false,
          }),
        );
        expect(paused.enabled).toBe(false);
        expect(paused.accounts).toEqual(beforePause.accounts);
        expect((yield* call(bob.id, "queries.inspect")).status).toBe(409);
        const disabledDiscovery = yield* client.use(
          "Disabled accounts leave the MCP catalog",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return tools.search({namespace:${JSON.stringify(app.slug)},limit:100});`,
                },
              },
              undefined,
              { signal },
            ),
        );
        const enabledCatalog = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            execution: Schema.Struct({
              ok: Schema.Literal(true),
              value: Schema.Struct({
                items: Schema.Array(Schema.Struct({ path: Schema.String })),
              }),
            }),
            unavailableApps: Schema.Array(
              Schema.Struct({ profile: Schema.optional(Schema.String) }),
            ),
          }),
        )(disabledDiscovery.structuredContent);
        expect(
          enabledCatalog.execution.value.items.some((item) => item.path.includes(alice.id)),
        ).toBe(true);
        expect(
          enabledCatalog.execution.value.items.some((item) => item.path.includes(bob.id)),
        ).toBe(false);
        expect(enabledCatalog.unavailableApps.some((item) => item.profile === bob.id)).toBe(false);

        const pauseDeadline = (yield* Clock.currentTimeMillis) + 40000;
        for (;;) {
          const state = yield* body(
            Profile,
            yield* api.request(agent, "POST", `${path}/profiles/${bob.id}/reconcile`),
          );
          if (state.status === "disabled") break;
          expect(state.status).not.toBe("failed");
          expect(yield* Clock.currentTimeMillis).toBeLessThan(pauseDeadline);
          yield* Effect.sleep("200 millis");
        }
        expect(
          (yield* body(Hooks, yield* api.request(agent, "GET", `${path}/webhooks`))).filter(
            (hook) => hook.profile === bob.id && hook.status !== "stopped",
          ),
        ).toHaveLength(0);
        expect(
          (yield* api.request(agent, "GET", `${path}/workflow-runs/${waiting.id}`)).body,
        ).toMatchObject({ status: "terminated" });
        const pausedSchedules = yield* api.request(
          agent,
          "GET",
          `${path}/schedules?profile=${bob.id}`,
        );
        expect(
          yield* body(Schema.Array(Schema.Struct({ enabled: Schema.Boolean })), pausedSchedules),
        ).toEqual([{ enabled: true }]);
        const resumed = yield* body(
          Profile,
          yield* api.request(agent, "PATCH", `${path}/profiles/${bob.id}/enabled`, {
            expectedRevision: paused.revision,
            enabled: true,
          }),
        );
        expect(resumed.id).toBe(bob.id);
        expect(resumed.accounts).toEqual(beforePause.accounts);
        yield* ready(bob.id);
        expect((yield* call(bob.id, "queries.inspect")).status).toBe(200);
        expect(
          (yield* body(Hooks, yield* api.request(agent, "GET", `${path}/webhooks`))).filter(
            (hook) => hook.profile === bob.id && hook.status === "active",
          ),
        ).toHaveLength(1);
        const removed = yield* api.request(agent, "DELETE", `${path}/profiles/${alice.id}`);
        expect((yield* body(Profile, removed)).status).toBe("removed");
        expect((yield* call(alice.id, "queries.inspect")).status).toBe(409);
        expect((yield* call(bob.id, "queries.inspect")).status).toBe(200);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
