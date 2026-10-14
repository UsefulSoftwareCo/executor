/** Local app account links through the real SDK HTTP surface, dashboard API, MCP and workflow engine. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Redacted, Schema } from "effect";
import { Api, body, type Session } from "../support/api.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { McpClient } from "../support/mcp-client.ts";
import { pairLocalOperator } from "../support/mcp-consent.ts";
import { connectAccountsThroughOtherApp, connectLocalAccount } from "../support/app-accounts.ts";
import { linkLocal, localAccountLinks, unlinkLocal } from "../support/local-links.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Subscriptions = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    actor: Schema.String,
    deployment: Schema.String,
    sourceAccount: Schema.String,
    status: Schema.String,
    callbackUrl: Schema.String,
  }),
);
const Sources = Schema.Array(
  Schema.Struct({
    account: Schema.String,
    actor: Schema.String,
    label: Schema.String,
    status: Schema.String,
    failure: Schema.NullOr(Schema.String),
    reconciledDeployment: Schema.NullOr(Schema.String),
  }),
);
const Deployed = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    activeDeployment: Schema.String,
    slug: Schema.String,
  }),
});
const Completed = Schema.Struct({ status: Schema.Literal("completed"), value: Schema.Json });
const Context = Schema.Struct({ auth: Schema.Boolean, profile: Schema.Boolean });
const Inspected = Schema.Struct({
  context: Context,
  mail: Schema.Array(Schema.String),
  sink: Schema.String,
  registrations: Schema.Array(
    Schema.Struct({
      subscription: Schema.String,
      context: Schema.fromJsonString(Context),
      source: Schema.String,
    }),
  ),
  totalRows: Schema.Number,
});
const serviceProvider = `defineProvider({ name: "Linked fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } })`;
const ledgerProvider = `defineProvider({ name: "Linked ledger", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } })`;
const files = [
  {
    path: "index.ts",
    content: `
import { defineApp, defineProvider, secrets, object, string, query, mutation, workflow, userInterval, router } from "apps";
const service = ${serviceProvider};
const ledger = ${ledgerProvider};
const shape = ctx => ({ auth: "auth" in ctx, profile: "profile" in ctx });
const write = mutation({ input: object({ body: string() }) }, async (ctx, input) => { ctx.sql.exec("INSERT INTO rows (account, body) VALUES (?, ?)", ctx.user.accounts.sink.id, input.body); return ctx.user.accounts.sink.id; });
const inspect = query({ input: object({}) }, async (ctx) => ({ context: shape(ctx), mail: ctx.user.accounts.mail.map(a => a.id), sink: ctx.user.accounts.sink.id, registrations: ctx.sql.exec("SELECT subscription, context, source FROM registrations ORDER BY seq").toArray(), totalRows: ctx.sql.exec("SELECT count(*) AS n FROM rows").one().n }));
const capture = workflow({ input: object({ source: string() }) }, async (ctx, input) => {
 await ctx.step.sleep("before snapshot", "1 second");
 return ctx.step.do("read accounts", async step => ({ context: shape(step), mail: step.user.accounts.mail.map(a => a.id), sink: step.user.accounts.sink.id, source: input.source }));
});
const empty = object({});
const incoming = { account: { user: "mail" }, config: empty, state: empty,
 register: async (ctx, { account, subscriptionId }) => {
   ctx.sql.exec("INSERT INTO registrations (subscription, context, source) VALUES (?, ?, ?) ON CONFLICT (subscription) DO NOTHING", subscriptionId, JSON.stringify(shape(ctx)), account.id);
   return {};
 },
 handle: async (ctx, { account, request }) => {
   if (request.headers.get("x-fixture-signature") !== "linked-proof") return new Response(null, { status: 401 });
   const event = await request.json();
   const run = await ctx.workflows.start({ workflow: "capture", input: { source: account.id }, key: event.id });
   return Response.json({ run: run.id });
 },
 unregister: async (ctx, { subscriptionId }) => {
   ctx.sql.exec("DELETE FROM registrations WHERE subscription = ?", subscriptionId);
 }
};
export default defineApp({ user: { accounts: { mail: service.many(), sink: ledger } } }, { tools: router({ inspect, write }), workflows: { capture }, webhooks: { incoming }, schedules: { summary: userInterval({ minutes: 1 }, write, { body: "scheduled" }) } });
`,
  },
  {
    path: "migrations/0001_linked.sql",
    content: `CREATE TABLE rows (seq INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE registrations (seq INTEGER PRIMARY KEY AUTOINCREMENT, subscription TEXT NOT NULL UNIQUE, context TEXT NOT NULL, source TEXT NOT NULL);
`,
  },
  appsManifest,
];

layer(TestLive, { excludeTestServices: true })("Linked accounts", (it) => {
  it.effect(scenarios.linkedAccounts.title, (context) =>
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
        const owner = "local";
        const deployment = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner,
          name: "Linked fixture",
          files,
        });
        expect(deployment.status, JSON.stringify(deployment.body)).toBe(200);
        const { app } = yield* body(Deployed, deployment);
        const path = `/v1/apps/${app.id}`;
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const account of accounts)
              yield* api.request(agent, "DELETE", `${path}/webhook-sources/${account}`);
            yield* api.request(agent, "DELETE", path);
            for (const account of accounts)
              yield* api.request(agent, "DELETE", `/v1/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const poll = <A, E>(
          label: string,
          read: Effect.Effect<A, E>,
          done: (value: A) => boolean,
        ) =>
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + 30000;
            for (;;) {
              const value = yield* read;
              if (done(value)) return value;
              expect(
                yield* Clock.currentTimeMillis,
                `${label}: ${JSON.stringify(value)}`,
              ).toBeLessThan(deadline);
              yield* Effect.sleep("200 millis");
            }
          });
        const sources = Effect.gen(function* () {
          const response = yield* api.request(agent, "GET", `${path}/webhook-sources`);
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          return yield* body(Sources, response);
        });
        const subscriptions = Effect.gen(function* () {
          const response = yield* api.request(agent, "GET", `${path}/webhooks`);
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          return yield* body(Subscriptions, response);
        });

        // Accounts connected for another app stay saved but are not linked to this one.
        for (const [provider, labels] of [
          [ledgerProvider, ["sink-a", "sink-b"]],
          [serviceProvider, ["mail-b"]],
        ] as const)
          for (const account of yield* connectAccountsThroughOtherApp(agent, {
            provider,
            method: "key",
            accounts: labels.map((label) => ({ label, fields: { token: label } })),
          }))
            accounts.push(account.id);
        // Connecting an account from the app links it and makes it a webhook source.
        const connection = yield* api.request(agent, "POST", "/v1/account-connections", {
          owner,
          target: { app: app.id, requirement: "mail" },
        });
        expect(connection.status, JSON.stringify(connection.body)).toBe(200);
        const connected = yield* api.request(agent, "POST", "/v1/account-connections/submit", {
          connection: (yield* body(Resource, connection)).id,
          method: "key",
          label: "mail-a",
          fields: { token: "mail-a" },
        });
        expect(connected.status, JSON.stringify(connected.body)).toBe(200);
        accounts.push((yield* body(Resource, connected)).id);
        const [sinkA, sinkB, mailB, mailA] = accounts;
        if (!mailA || !mailB || !sinkA || !sinkB)
          return yield* Effect.die(new Error("Missing fixture account"));
        /** The app's links by requirement, each oldest first. */
        const links = localAccountLinks(agent, app.id).pipe(
          Effect.map((pairs) => {
            const grouped: Record<string, string[]> = {};
            for (const [requirement, account] of pairs) (grouped[requirement] ??= []).push(account);
            return grouped;
          }),
        );
        expect(yield* links).toEqual({ mail: [mailA] });

        // Calls name no accounts; they run with the app's links and share its storage.
        const kinds = { write: "mutation", inspect: "query" } as const;
        const call = (tool: keyof typeof kinds, input = {}) =>
          api.request(agent, "POST", "/v1/tools/call", {
            app: app.id,
            tool,
            kind: kinds[tool],
            input,
          });
        const inspected = Effect.gen(function* () {
          const response = yield* call("inspect");
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          return yield* Schema.decodeUnknownEffect(Inspected)(
            (yield* body(Completed, response)).value,
          );
        });
        const written = (text: string) =>
          Effect.gen(function* () {
            const response = yield* call("write", { body: text });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return (yield* body(Completed, response)).value;
          });
        // Without a linked sink account, the plain requirement has nothing to use.
        const unlinked = yield* call("inspect");
        expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(409);
        expect(unlinked.body).toMatchObject({ _tag: "AccountRequired", slot: "sink" });
        yield* linkLocal(agent, app.id, "sink", sinkA);
        expect(yield* written("first")).toBe(sinkA);
        expect(yield* inspected).toMatchObject({
          context: { auth: false, profile: false },
          mail: [mailA],
          sink: sinkA,
          totalRows: 1,
        });
        // A many() requirement uses every linked account: linking another adds it.
        yield* linkLocal(agent, app.id, "mail", mailB);
        expect(yield* links).toEqual({ mail: [mailA, mailB], sink: [sinkA] });
        expect(yield* inspected).toMatchObject({ mail: [mailA, mailB], sink: sinkA });
        // `sink` is plain, so linking sink-b to it replaces sink-a, which stays saved. Calls then
        // use sink-b with the same storage.
        yield* linkLocal(agent, app.id, "sink", sinkB);
        expect(yield* links).toEqual({ mail: [mailA, mailB], sink: [sinkB] });
        expect((yield* api.request(agent, "GET", `/v1/accounts/${sinkA}`)).status).toBe(200);
        expect(yield* written("second")).toBe(sinkB);
        expect(yield* inspected).toMatchObject({
          mail: [mailA, mailB],
          sink: sinkB,
          totalRows: 2,
        });

        // The SDK routes refuse an account choice instead of running with it.
        const Refused = Schema.Struct({ _tag: Schema.Literal("AccountChoiceUnsupported") });
        const chosenCall = yield* api.request(agent, "POST", "/v1/tools/call", {
          app: app.id,
          accounts: { app: {}, user: { mail: [mailA], sink: [sinkA] } },
          tool: "write",
          kind: "mutation",
          input: { body: "chosen" },
        });
        expect(chosenCall.status, JSON.stringify(chosenCall.body)).toBe(400);
        yield* body(Refused, chosenCall);
        const chosenStart = yield* api.request(agent, "POST", `${path}/workflow-runs`, {
          accounts: { app: {}, user: { mail: [mailA], sink: [sinkA] } },
          workflow: "capture",
          input: { source: "chosen" },
        });
        expect(chosenStart.status, JSON.stringify(chosenStart.body)).toBe(400);
        yield* body(Refused, chosenStart);
        expect((yield* inspected).totalRows).toBe(2);

        // The dashboard runs with the same links. Dashboard runs belong to the paired browser,
        // not the API key.
        const operator = yield* pairLocalOperator;
        const dashboardRun = yield* api.request(
          operator,
          "POST",
          `/dashboard/api/apps/${app.id}/tools/run`,
          { tool: "inspect", kind: "query", input: {} },
        );
        expect(dashboardRun.status, JSON.stringify(dashboardRun.body)).toBe(200);
        expect(
          yield* Schema.decodeUnknownEffect(Inspected)(
            (yield* body(Completed, dashboardRun)).value,
          ),
        ).toMatchObject({ mail: [mailA, mailB], sink: sinkB });

        // MCP lists the app once and runs it with the same links; its input offers no choice.
        const mcp = yield* McpClient;
        const client = yield* mcp.connect(target.apiKey, "linked-accounts");
        const execute = (step: string, code: string) =>
          client.use(step, (client, signal) =>
            client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
          );
        const discovery = yield* execute(
          "Discover the app's tools once",
          `return tools.search({namespace:${JSON.stringify(app.slug)},limit:100});`,
        );
        const found = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            execution: Schema.Struct({
              ok: Schema.Literal(true),
              value: Schema.Struct({
                items: Schema.Array(Schema.Struct({ path: Schema.String, input: Schema.String })),
              }),
            }),
          }),
        )(discovery.structuredContent);
        expect(found.execution.value.items.map((item) => item.path).sort()).toEqual(
          [
            `tools[${JSON.stringify(app.slug)}].inspect`,
            `tools[${JSON.stringify(app.slug)}].write`,
          ].sort(),
        );
        const input = found.execution.value.items.find((item) =>
          item.path.endsWith(".inspect"),
        )?.input;
        expect(input).not.toContain("$accounts");
        const tool = `tools[${JSON.stringify(app.slug)}].inspect`;
        const invoked = yield* execute(
          "Run the tool with the linked accounts",
          `return await ${tool}({});`,
        );
        const result = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            execution: Schema.Struct({ ok: Schema.Literal(true), value: Inspected }),
          }),
        )(invoked.structuredContent);
        expect(result.execution.value).toMatchObject({
          context: { auth: false, profile: false },
          mail: [mailA, mailB],
          sink: sinkB,
        });

        // Each linked mail account is a webhook source that registers with the app's links.
        yield* poll("The mail sources register", sources, (rows) =>
          [mailA, mailB].every((account) =>
            rows.some((row) => row.account === account && row.status === "ready"),
          ),
        );
        const active = (yield* subscriptions).filter((hook) => hook.status === "active");
        expect(active.map((hook) => hook.sourceAccount).sort()).toEqual([mailA, mailB].sort());
        expect(
          active.every(
            (hook) => hook.actor === "local" && hook.deployment === app.activeDeployment,
          ),
        ).toBe(true);
        const hook = active.find((item) => item.sourceAccount === mailA);
        if (hook === undefined) return yield* Effect.die(new Error("Missing subscription"));
        expect(
          (yield* inspected).registrations
            .map(({ source, context }) => ({ source, context }))
            .sort((a, b) => a.source.localeCompare(b.source)),
        ).toEqual(
          [mailA, mailB]
            .sort((a, b) => a.localeCompare(b))
            .map((source) => ({ source, context: { auth: false, profile: false } })),
        );

        // A delivery starts a run with the app's links; the run keeps them after the plain
        // requirement's link is replaced.
        const delivered = yield* api.request(
          session,
          "POST",
          new URL(hook.callbackUrl).pathname,
          { id: "message-one" },
          { "x-fixture-signature": "linked-proof" },
        );
        expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
        const run = (yield* body(Schema.Struct({ run: Schema.String }), delivered)).run;
        yield* linkLocal(agent, app.id, "sink", sinkA);
        expect(yield* links).toEqual({ mail: [mailA, mailB], sink: [sinkA] });
        const RunState = Schema.Struct({
          status: Schema.String,
          output: Schema.optional(Schema.Json),
        });
        const finished = (id: string) =>
          poll(
            "The workflow run completes",
            Effect.gen(function* () {
              const response = yield* api.request(agent, "GET", `${path}/workflow-runs/${id}`);
              expect(response.status).toBe(200);
              const state = yield* body(RunState, response);
              expect(state.status).not.toBe("errored");
              return state;
            }),
            (state) => state.status === "complete",
          );
        expect((yield* finished(run)).output).toMatchObject({
          context: { auth: false, profile: false },
          sink: sinkB,
          source: mailA,
        });
        const started = yield* api.request(agent, "POST", `${path}/workflow-runs`, {
          workflow: "capture",
          input: { source: "direct" },
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        expect((yield* finished((yield* body(Resource, started)).id)).output).toEqual({
          context: { auth: false, profile: false },
          mail: [mailA, mailB],
          sink: sinkA,
          source: "direct",
        });

        // The local subject's schedule copy runs with the same links; there is nothing to choose.
        const schedules = Effect.gen(function* () {
          const response = yield* api.request(agent, "GET", `${path}/schedules`);
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          return yield* body(
            Schema.Array(
              Schema.Struct({
                name: Schema.String,
                actor: Schema.String,
                enabled: Schema.Boolean,
                accountRequired: Schema.optional(Schema.String),
              }),
            ),
            response,
          );
        });
        expect(yield* schedules).toEqual([]);
        const configured = yield* api.request(agent, "PATCH", `${path}/schedules/summary`, {
          actor: "local",
          enabled: true,
        });
        expect(configured.status, JSON.stringify(configured.body)).toBe(200);
        expect(yield* schedules).toEqual([{ name: "summary", actor: "local", enabled: true }]);
        const copy = (yield* body(Schema.Struct({ id: Schema.String }), configured)).id;
        expect(
          (yield* api.request(agent, "POST", `${path}/schedules/summary/copies/${copy}/run`, {}))
            .status,
        ).toBe(200);
        yield* poll(
          "The scheduled run succeeds",
          Effect.gen(function* () {
            const rows = yield* body(
              Schema.Array(Schema.Struct({ status: Schema.String })),
              yield* api.request(agent, "GET", `/v1/scheduled-runs?app=${app.id}`),
            );
            expect(rows.some((row) => row.status === "failed")).toBe(false);
            return rows;
          }),
          (rows) => rows.some((row) => row.status === "succeeded"),
        );

        // A new deployment keeps the storage; webhook sources register on it.
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
        const afterDeploy = yield* call("inspect");
        expect(afterDeploy.status, JSON.stringify(afterDeploy.body)).toBe(200);
        expect((yield* body(Completed, afterDeploy)).value).toMatchObject({
          version: "two",
          sink: sinkA,
          totalRows: 3,
        });
        yield* poll("The source registers on the new deployment", sources, (rows) =>
          rows.some(
            (row) =>
              row.account === mailA &&
              row.status === "ready" &&
              row.reconciledDeployment === activated.app.activeDeployment,
          ),
        );
        const replaced = yield* subscriptions;
        expect(
          replaced.some(
            (item) =>
              item.status === "active" &&
              item.sourceAccount === mailA &&
              item.deployment === activated.app.activeDeployment,
          ),
        ).toBe(true);
        expect(replaced.find((item) => item.id === hook.id)?.status).toBe("stopped");

        // Unlinking stops the account's webhook source; the account stays saved.
        yield* unlinkLocal(agent, app.id, "mail", mailA);
        yield* poll("The unlinked source is removed", sources, (rows) =>
          rows.every((row) => row.account !== mailA),
        );
        expect(
          (yield* subscriptions).filter(
            (item) => item.sourceAccount === mailA && item.status !== "stopped",
          ),
        ).toEqual([]);
        expect((yield* api.request(agent, "GET", `/v1/accounts/${mailA}`)).status).toBe(200);

        // Unlinking the sink leaves the schedule waiting for an account; it never runs with
        // another saved account.
        yield* unlinkLocal(agent, app.id, "sink", sinkA);
        expect(yield* links).toEqual({ mail: [mailB] });
        expect(yield* schedules).toEqual([
          { name: "summary", actor: "local", enabled: true, accountRequired: "sink" },
        ]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.webhookSourceConfigureExpected.title, (context) =>
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
        const owner = "local";
        const sourceRevisionProvider = `defineProvider({ name: "Source revision fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } })`;
        const deployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner,
          name: "Source revision fixture",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = ${sourceRevisionProvider};
const incoming = { account: { user: "service" }, config: object({ channel: string().optional() }), state: object({}),
  register: async () => ({}), unregister: async () => {}, handle: async () => new Response(null, { status: 204 }) };
export default defineApp({ user: { accounts: { service } } }, { tools: router({ ping: query({ input: object({}) }, async () => "pong") }), webhooks: { incoming } });`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = (yield* body(Schema.Struct({ app: Resource }), deployed)).app;
        const path = `/v1/apps/${app.id}`;
        // Connected for another app, so the account is linked but not yet this app's source.
        const [created] = yield* connectAccountsThroughOtherApp(agent, {
          provider: sourceRevisionProvider,
          method: "key",
          accounts: [{ label: "source", fields: { token: "source" } }],
        });
        if (created === undefined) return yield* Effect.die(new Error("Missing fixture account"));
        const account = created.id;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(agent, "DELETE", `${path}/webhook-sources/${account}`);
            yield* api.request(agent, "DELETE", path);
            yield* api.request(agent, "DELETE", `/v1/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const Source = Schema.Struct({
          id: Schema.String,
          revision: Schema.Number,
          account: Schema.String,
          actor: Schema.String,
          config: Schema.Record(Schema.String, Schema.Unknown),
          status: Schema.String,
        });
        const sourceOf = api.request(agent, "GET", `${path}/webhook-sources`).pipe(
          Effect.flatMap((response) => body(Schema.Array(Source), response)),
          Effect.map((sources) => sources.find((source) => source.account === account)),
        );
        const configure = (
          expected: { id: string; actor: string; revision: number },
          channel: string,
        ) =>
          api.request(agent, "PATCH", `${path}/webhook-sources/${account}`, {
            expected,
            config: { incoming: { channel } },
          });
        const link = api.request(agent, "PUT", `${path}/webhook-sources/${account}`, {
          actor: "local",
        });
        expect((yield* link).status).toBe(200);
        const read = yield* sourceOf;
        if (read === undefined) return yield* Effect.die(new Error("Missing webhook source"));
        const expected = { id: read.id, actor: read.actor, revision: read.revision };

        // The source the caller read is changed and keeps its actor.
        const saved = yield* configure(expected, "first");
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(saved.body).toMatchObject({
          id: read.id,
          actor: "local",
          revision: read.revision + 1,
          config: { incoming: { channel: "first" } },
          status: "pending",
        });
        // A revision read before that change, or another actor, no longer names the source.
        for (const stale of [
          expected,
          { ...expected, revision: read.revision + 1, actor: "other" },
        ]) {
          const refused = yield* configure(stale, "stale");
          expect(refused.status, JSON.stringify(refused.body)).toBe(409);
          expect(refused.body).toMatchObject({ _tag: "WebhookConflict" });
        }
        expect((yield* sourceOf)?.config).toEqual({ incoming: { channel: "first" } });

        // Once unlinked, the source cannot be changed back to pending, nor recreated.
        const current = { ...expected, revision: read.revision + 1 };
        expect(
          (yield* api.request(agent, "DELETE", `${path}/webhook-sources/${account}`)).status,
        ).toBe(200);
        const removing = yield* configure(
          { ...current, revision: current.revision + 1 },
          "removing",
        );
        expect(removing.status, JSON.stringify(removing.body)).toBe(409);
        const deadline = (yield* Clock.currentTimeMillis) + 30_000;
        while ((yield* sourceOf) !== undefined) {
          expect(
            yield* Clock.currentTimeMillis,
            "The unlinked source was not removed",
          ).toBeLessThan(deadline);
          yield* Effect.sleep("200 millis");
        }
        const removed = yield* configure({ ...current, revision: current.revision + 1 }, "removed");
        expect(removed.status, JSON.stringify(removed.body)).toBe(409);
        expect(yield* sourceOf).toBeUndefined();

        // Linking the account again creates another source, which an earlier read does not name.
        expect((yield* link).status).toBe(200);
        const relinked = yield* sourceOf;
        expect(relinked?.id).not.toBe(read.id);
        const replaced = yield* configure(
          { ...expected, revision: relinked?.revision ?? 0 },
          "replaced",
        );
        expect(replaced.status, JSON.stringify(replaced.body)).toBe(409);
      }),
    ),
  );
  it.effect(scenarios.localHistoricalSkillAccounts.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          session = yield* api.session(),
          mcp = yield* McpClient;
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
        const owner = "local";
        /** An app whose skill text depends on the account of the named requirement. */
        const version = (requirement: string) => [
          {
            path: "index.ts",
            content: `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({ name: "Historical skill fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { ${requirement}: service } } }, async (ctx) => ({
  tools: router({ ping: query({ input: object({}) }, async () => "pong") }),
  skills: [{ name: "selected-account", description: "Instructions for the selected account", files: [{ path: "SKILL.md",
    content: "---\\nname: selected-account\\ndescription: Instructions for the selected account\\n---\\n" + ctx.user.accounts.${requirement}.id }] }],
}));`,
          },
          appsManifest,
        ];
        const Deployment = Schema.Struct({
          app: Schema.Struct({
            id: Schema.String,
            slug: Schema.String,
            activeDeployment: Schema.String,
          }),
        });
        const deployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner,
          name: "Historical skill fixture",
          files: version("service"),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Deployment, deployed);
        const created: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(agent, "DELETE", `/v1/apps/${app.id}`);
            for (const id of created) yield* api.request(agent, "DELETE", `/v1/accounts/${id}`);
          }).pipe(Effect.orDie),
        );
        /** Connect an account from the app for one requirement, which links it there. */
        const connect = (requirement: string, token: string) =>
          Effect.gen(function* () {
            const connected = yield* connectLocalAccount(agent, {
              app: app.id,
              requirement,
              method: "key",
              label: token,
              fields: { token },
            });
            created.push(connected.id);
            return connected.id;
          });
        const account = yield* connect("service", "historical");
        const SkillRead = Schema.Struct({ deployment: Schema.String, content: Schema.String });
        const read = (query: string) =>
          api.request(
            agent,
            "GET",
            `/dashboard/api/apps/${app.id}/skills/selected-account${query}`,
          );
        const first = yield* body(SkillRead, yield* read(""));
        expect(first).toMatchObject({
          deployment: app.activeDeployment,
          content: expect.stringContaining(account),
        });
        // A newer deployment renames the requirement the skill's text depends on.
        const redeployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner,
          app: app.id,
          files: version("mail"),
        });
        expect(redeployed.status, JSON.stringify(redeployed.body)).toBe(200);
        // Links name their requirement, so the renamed one has none until an account is linked
        // to it: the current skill needs one.
        const unlinked = yield* read("");
        expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(409);
        expect(unlinked.body).toMatchObject({ _tag: "AccountRequired", slot: "mail" });
        const renamed = yield* connect("mail", "renamed");
        const current = yield* body(SkillRead, yield* read(""));
        expect(current.deployment).not.toBe(first.deployment);
        expect(current.content).toContain(renamed);
        expect(current.content).not.toContain(account);
        // The earlier deployment's skill reads with that deployment's own requirement, whose link
        // to the first account remains.
        const pinned = yield* read(`?deployment=${first.deployment}`);
        expect(pinned.status, JSON.stringify(pinned.body)).toBe(200);
        expect(yield* body(SkillRead, pinned)).toMatchObject({
          deployment: first.deployment,
          content: expect.stringContaining(account),
        });
        const client = yield* mcp.connect(target.apiKey, "historical-skill");
        const viaMcp = yield* client.use("Read the earlier deployment's skill", (client, signal) =>
          client.callTool(
            {
              name: "skills",
              arguments: { app: app.slug, name: "selected-account", deployment: first.deployment },
            },
            undefined,
            { signal },
          ),
        );
        expect(viaMcp.isError, JSON.stringify(viaMcp)).not.toBe(true);
        expect(viaMcp.structuredContent).toMatchObject({
          deployment: first.deployment,
          content: expect.stringContaining(account),
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
