/**
 * Builds of the frameworks from before routers keep working, unchanged, on the router host. One app
 * is pinned to the published `apps@0.0.1-beta.0` (protocol 1), another to the published
 * `apps@0.0.1-beta.4` (protocol 2), a third to the published `apps@0.0.1-beta.5` (protocol 3).
 * Each protocol's generated server entry is the one hosts used before routers, so its retained
 * build is the same artifact such a host kept.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
import { publishedRelease } from "../support/app-package.ts";
import { appsManifest, appsVersion } from "../support/apps-release.ts";
import { serverControl } from "../support/server-control.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { skillUpstream } from "../support/skill-upstream.ts";

/** Single-file source written for the protocol-1 framework: queries and mutations catalogs. */
const legacy = (revision: string) => [
  {
    path: "index.ts",
    content: `import * as apps from "apps";
import { defineApp, defineDatabase, table, query, mutation, workflow, interval, object, string } from "apps";
import { always } from "apps/operations/approval";
// ${revision}
const database = defineDatabase({ notes: table({ text: string() }) });
const framework = () => ("router" in apps ? "routers" : "protocol 1");
const notes = query({ input: object({}) }, async ({ db }) => (await db.notes.withIndex("by_creation").collect()).map((row) => row.text));
const save = mutation({ input: object({ text: string() }) }, async ({ db }, input) => { await db.notes.insert(input); return framework(); });
const review = mutation({ input: object({}), approval: always() }, async ({ db }) => { await db.notes.insert({ text: "reviewed" }); return true; });
const record = workflow({ input: object({ text: string() }) }, async (ctx, input) => {
  await ctx.step.runMutation("save", save, input);
  return ctx.step.runQuery("read", notes, {});
});
export default defineApp({ accounts: {}, database }, {
  queries: { notes },
  mutations: { save, review },
  workflows: { record },
  schedules: { nightly: interval({ minutes: 60 }, review, {}) },
});`,
  },
];

/**
 * Single-file source written for `apps@0.0.1-beta.4`, protocol 2: queries and mutations catalogs
 * from a factory, and remote skills that its `dynamicSkills` loader reads through the app cache.
 */
const catalogs = (revision: string, upstream: string) => [
  {
    path: "index.ts",
    content: `import * as apps from "apps";
import { defineApp, defineDatabase, dynamicSkills, table, query, mutation, workflow, object, string } from "apps";
import { wellKnownSkills } from "apps/skills";
// ${revision}
const database = defineDatabase({ notes: table({ text: string() }) });
const framework = () => ("router" in apps ? "routers" : "protocol 2");
const notes = query({ input: object({}) }, async ({ db }) => (await db.notes.withIndex("by_creation").collect()).map((row) => row.text));
const save = mutation({ input: object({ text: string() }) }, async ({ db }, input) => { await db.notes.insert(input); return framework(); });
const record = workflow({ input: object({ text: string() }) }, async (ctx, input) => {
  await ctx.step.runMutation("save", save, input);
  return ctx.step.runQuery("read", notes, {});
});
export default defineApp({ accounts: {}, database }, async (ctx) => ({
  queries: { notes },
  mutations: { save },
  workflows: { record },
  dynamicSkills: dynamicSkills({ list: async () => wellKnownSkills({ url: ${JSON.stringify(upstream)}, cache: ctx.cache, freshFor: "1 hour", fetch: ctx.fetch, signal: ctx.signal }) }),
}));`,
  },
];

/** The marker a protocol-3 app's own error carries. */
const appMarker = "Synthetic conversation is missing";

/**
 * Single-file source written for `apps@0.0.1-beta.5`, protocol 3: queries and mutations catalogs,
 * and a query and a workflow step that throw the app's own named error.
 */
const detailed = (revision: string) => [
  {
    path: "index.ts",
    content: `import * as apps from "apps";
import { defineApp, defineDatabase, table, query, mutation, workflow, object, string } from "apps";
// ${revision}
class ConversationMissing extends Error { name = "ConversationMissing"; }
const database = defineDatabase({ notes: table({ text: string() }) });
const framework = () => ("router" in apps ? "routers" : "protocol 3");
const notes = query({ input: object({}) }, async ({ db }) => (await db.notes.withIndex("by_creation").collect()).map((row) => row.text));
const fail = query({ input: object({}) }, async () => { throw new ConversationMissing(${JSON.stringify(appMarker)}); });
const save = mutation({ input: object({ text: string() }) }, async ({ db }, input) => { await db.notes.insert(input); return framework(); });
const record = workflow({ input: object({ text: string() }) }, async (ctx, input) => {
  await ctx.step.runMutation("save", save, input);
  return ctx.step.runQuery("read", notes, {});
});
const broken = workflow({ input: object({}) }, async (ctx) =>
  ctx.step.runQuery("explode", fail, {}, { retries: { limit: 0, delay: 0 } }));
export default defineApp({ accounts: {}, database }, {
  queries: { notes, fail },
  mutations: { save },
  workflows: { record, broken },
});`,
  },
];

/**
 * The same app rewritten for the host's release: routers, as protocol 4 requires, and SQL. Its
 * first migration copies the notes the earlier document store kept. `source.lazy` resolves without
 * being listed, so the catalog cannot give its kind.
 */
const routed = [
  {
    path: "index.ts",
    content: `import * as apps from "apps";
import { defineApp, query, mutation, object, string, router, dynamicRouter } from "apps";
const framework = () => ("router" in apps ? "routers" : "protocol 1");
const insert = "INSERT INTO notes (text) VALUES (?)";
const notes = query({ input: object({}) }, async ({ sql }) => sql.exec("SELECT text FROM notes ORDER BY seq").toArray().map((row) => row.text));
const save = mutation({ input: object({ text: string() }) }, async ({ sql }, input) => { sql.exec(insert, input.text); return framework(); });
const lazy = mutation({ input: object({ text: string() }) }, async ({ sql }, input) => { sql.exec(insert, input.text); return "resolved"; });
const source = dynamicRouter({ list: async () => [], resolve: async (name) => (name === "lazy" ? lazy : undefined) });
export default defineApp({ accounts: {} }, { tools: router({ notes, save, source }) });`,
  },
  {
    path: "migrations/0001_notes.sql",
    content: `CREATE TABLE notes (seq INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL);
INSERT INTO notes (text)
SELECT json_extract(body, '$.text') FROM _executor_legacy_rows
WHERE table_name = 'notes'
ORDER BY json_extract(body, '$.createdAt'), id;
`,
  },
];

const Catalog = Schema.Struct({
  items: Schema.Array(Schema.Struct({ name: Schema.String, readOnly: Schema.Boolean })),
  routers: Schema.Array(Schema.Unknown),
});
const Runs = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String }),
);
const WorkflowRun = Schema.Struct({
  status: Schema.String,
  output: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.String),
});
const SettledRun = Schema.Struct({
  status: Schema.String,
  output: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(
    Schema.Struct({
      step: Schema.optionalKey(Schema.String),
      errorName: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
    }),
  ),
});
const ToolFailed = Schema.Struct({
  _tag: Schema.Literal("ToolCallFailed"),
  reason: Schema.String,
  failure: Schema.Struct({
    source: Schema.String,
    errorName: Schema.String,
    message: Schema.String,
  }),
});
const Executed = Schema.Struct({
  execution: Schema.Struct({ ok: Schema.Boolean, value: Schema.optional(Schema.Unknown) }),
});
const Search = Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) });
const Bundle = Schema.Struct({
  revision: Schema.String,
  skills: Schema.Array(Schema.Struct({ name: Schema.String })),
});
class Pending extends Schema.TaggedError<Pending>()("Pending", {}) {}

/** Poll until a condition holds. */
const eventually = <A, E, R>(check: Effect.Effect<A, E | Pending, R>) =>
  check.pipe(
    Effect.retry({
      while: (error) => error instanceof Pending,
      schedule: Schedule.spaced("100 millis"),
    }),
    Effect.timeout("20 seconds"),
  );

layer(HostedLive, { excludeTestServices: true })("Apps from before routers", (it) => {
  it.effect(scenarios.appProtocol1.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const created: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(created, (id) =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${id}`),
          ).pipe(Effect.orDie),
        );
        const pinnedTo = (url: string) => ({
          path: "package.json",
          content: JSON.stringify({ dependencies: { apps: url } }),
        });
        const beta0 = yield* publishedRelease("0.0.1-beta.0");
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Protocol one ${randomUUID().slice(0, 8)}`,
          files: [...legacy("first"), pinnedTo(beta0.url)],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        created.push(app.id);
        const path = `${prefix}/apps/${app.id}`;
        const call = (tool: string, input: Record<string, string>, kind?: "query" | "mutation") =>
          api.request(actors.owner, "POST", `${path}/tools/call`, {
            tool,
            input,
            ...(kind === undefined ? {} : { kind }),
          });
        expect((yield* call("mutations.save", { text: "before" }, "mutation")).body).toBe(
          "protocol 1",
        );
        // A scheduled run that needs review saves an approval naming mutations.review.
        const schedules = `${path}/schedules`;
        expect(
          (yield* api.request(actors.owner, "PATCH", `${schedules}/nightly`, {
            enabled: true,
            approvalMode: "browser",
          })).status,
        ).toBe(200);
        const runs = api
          .request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`)
          .pipe(Effect.flatMap((response) => body(Runs, response)));
        const waitFor = (status: string, count = 1) =>
          runs.pipe(
            Effect.flatMap((rows) => {
              const found = rows.filter((row) => row.name === "nightly" && row.status === status);
              return found.length >= count ? Effect.succeed(found[0]!) : Effect.fail(new Pending());
            }),
            Effect.retry({
              while: (error) => error instanceof Pending,
              schedule: Schedule.spaced("100 millis"),
            }),
            Effect.timeout("20 seconds"),
          );
        expect((yield* api.request(actors.owner, "POST", `${schedules}/nightly/run`)).status).toBe(
          200,
        );
        const pending = yield* waitFor("awaiting-approval");

        // The host restarts and loads the retained build again, without rebuilding it. Its data
        // and the saved approval are unchanged.
        yield* serverControl("restart");

        const catalog = yield* body(
          Catalog,
          yield* api.request(actors.owner, "GET", `${path}/tools`),
        );
        expect(catalog.items.map((tool) => [tool.name, tool.readOnly]).toSorted()).toEqual([
          ["mutations.review", false],
          ["mutations.save", false],
          ["queries.notes", true],
        ]);
        expect(catalog.routers).toEqual([]);
        expect((yield* call("queries.notes", {})).body).toEqual(["before"]);
        expect((yield* call("queries.notes", {}, "query")).body).toEqual(["before"]);
        expect((yield* call("mutations.save", { text: "inferred" })).body).toBe("protocol 1");
        expect((yield* call("mutations.save", { text: "named" }, "mutation")).body).toBe(
          "protocol 1",
        );
        const mismatch = yield* call("queries.notes", {}, "mutation");
        expect(mismatch.status).toBe(409);
        expect(mismatch.body).toMatchObject({
          _tag: "ToolKindMismatch",
          requested: "mutation",
          actual: "query",
        });

        // Workflow steps from the protocol-1 bundle name operations without their kind prefix.
        const started = yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
          workflow: "record",
          input: { text: "workflow" },
          key: randomUUID(),
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const run = yield* body(Schema.Struct({ id: Schema.String }), started);
        const completed = yield* api
          .request(actors.owner, "GET", `${path}/workflow-runs/${run.id}`)
          .pipe(
            Effect.flatMap((response) => body(WorkflowRun, response)),
            Effect.flatMap((run) =>
              ["queued", "running", "waiting"].includes(run.status)
                ? Effect.fail(new Pending())
                : Effect.succeed(run),
            ),
            Effect.retry({
              while: (error) => error instanceof Pending,
              schedule: Schedule.spaced("100 millis"),
            }),
            Effect.timeout("20 seconds"),
          );
        expect(completed).toEqual({
          status: "complete",
          output: ["before", "inferred", "named", "workflow"],
        });

        // The approval saved before the upgrade resumes the protocol-1 mutation.
        const approval = `${prefix}/scheduled-runs/${pending.id}/approval`;
        expect(
          (yield* api.request(actors.owner, "POST", approval, {
            response: { action: "accept", content: {} },
          })).body,
        ).toEqual({ status: "answered" });
        yield* waitFor("succeeded");
        expect((yield* call("queries.notes", {})).body).toContain("reviewed");
        expect(
          (yield* api.request(actors.owner, "PATCH", `${schedules}/nightly`, {
            enabled: true,
            approvalMode: "automatic",
          })).status,
        ).toBe(200);
        expect((yield* api.request(actors.owner, "POST", `${schedules}/nightly/run`)).status).toBe(
          200,
        );
        yield* waitFor("succeeded", 2);

        // Agents search and call the old names through MCP.
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Protocol one",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "app-protocol-1", {
          organization: actors.organization.id,
        });
        const execute = (label: string, code: string) =>
          client
            .use(label, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Executed)(result.structuredContent),
              ),
            );
        const search = yield* execute(
          "Search the protocol-1 app",
          `return await tools.search({ query: "notes", namespace: ${JSON.stringify(app.slug)} });`,
        );
        expect(search.execution.ok).toBe(true);
        expect(
          (yield* Schema.decodeUnknownEffect(Search)(search.execution.value)).items.map(
            (item) => item.path,
          ),
        ).toEqual([`tools[${JSON.stringify(app.slug)}].queries.notes`]);
        const saved = yield* execute(
          "Call a protocol-1 mutation",
          `return await tools[${JSON.stringify(app.slug)}].mutations.save({ text: "agent" });`,
        );
        expect(saved.execution).toEqual({ ok: true, value: "protocol 1" });

        // Every app declares its framework. Source without a declaration is refused with the
        // release to add, and the running build keeps serving.
        const unpinned = yield* saveAndDeploy(actors.owner, path, { files: legacy("second") });
        expect(unpinned.status, JSON.stringify(unpinned.body)).toBe(422);
        expect(unpinned.body).toMatchObject({
          _tag: "DeploymentBuildFailed",
          reason: `Add "apps": "${appsVersion}" to package.json dependencies. Every app declares the exact apps version it uses; ${appsVersion} is this host's.`,
        });
        expect((yield* call("mutations.save", { text: "still one" })).body).toBe("protocol 1");

        // Pinned to either published protocol-1 release, the same source rebuilds and runs unchanged.
        for (const version of ["0.0.1-beta.0", "0.0.1-beta.1"] as const) {
          const release = yield* publishedRelease(version);
          const pinned = yield* saveAndDeploy(actors.owner, path, {
            files: [...legacy(version), pinnedTo(release.url)],
          });
          expect(pinned.status, JSON.stringify(pinned.body)).toBe(200);
          expect((yield* release.requests)[release.route]).toBeGreaterThan(0);
          expect((yield* call("mutations.save", { text: version })).body).toBe("protocol 1");
          expect((yield* call("queries.notes", {}, "query")).body).toContain(version);
        }

        // A new app declares the host's release, protocol 4, and must use routers.
        const fresh = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Router app ${randomUUID().slice(0, 8)}`,
          files: [...routed, appsManifest],
        });
        expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
        const second = yield* body(App, fresh);
        created.push(second.id);
        expect(
          (yield* api.request(actors.owner, "POST", `${prefix}/apps/${second.id}/tools/call`, {
            tool: "save",
            input: { text: "new" },
          })).body,
        ).toBe("routers");
        // A tool the catalog doesn't list is called without a kind and runs as its own kind.
        const secondCall = (
          tool: string,
          input: Record<string, string>,
          kind?: "query" | "mutation",
        ) =>
          api.request(actors.owner, "POST", `${prefix}/apps/${second.id}/tools/call`, {
            tool,
            input,
            ...(kind === undefined ? {} : { kind }),
          });
        expect((yield* secondCall("source.lazy", { text: "unlisted" })).body).toBe("resolved");
        expect((yield* secondCall("source.lazy", { text: "named" }, "mutation")).body).toBe(
          "resolved",
        );
        const unlistedMismatch = yield* secondCall("source.lazy", { text: "never" }, "query");
        expect(unlistedMismatch.status).toBe(409);
        expect(unlistedMismatch.body).toMatchObject({
          _tag: "ToolKindMismatch",
          actual: "mutation",
        });
        expect((yield* secondCall("notes", {})).body).toEqual(["new", "unlisted", "named"]);

        // Upgrading to the host's release needs router source: protocol-1 source is refused.
        const refused = yield* saveAndDeploy(actors.owner, path, {
          files: [...legacy("upgrade"), appsManifest],
        });
        expect(refused.status, JSON.stringify(refused.body)).toBe(422);
        expect((yield* call("mutations.save", { text: "still pinned" })).body).toBe("protocol 1");
        const upgraded = yield* saveAndDeploy(actors.owner, path, {
          files: [...routed, appsManifest],
        });
        expect(upgraded.status, JSON.stringify(upgraded.body)).toBe(200);
        expect(
          (yield* body(Catalog, yield* api.request(actors.owner, "GET", `${path}/tools`))).items
            .map((tool) => tool.name)
            .toSorted(),
        ).toEqual(["notes", "save"]);
        expect((yield* call("save", { text: "upgraded" })).body).toBe("routers");
        // The upgraded app keeps the notes its document store held; its migration copied them.
        const kept = yield* body(Schema.Array(Schema.String), yield* call("notes", {}, "query"));
        expect(kept).toContain("still pinned");
        expect(kept.at(-1)).toBe("upgraded");
      }).pipe(Effect.provide(Layer.merge(McpOAuth.layer, McpClient.layer))),
    ),
  );

  it.effect(scenarios.appProtocol2.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const upstream = yield* skillUpstream;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const beta4 = yield* publishedRelease("0.0.1-beta.4");
        const pinned = {
          path: "package.json",
          content: JSON.stringify({ dependencies: { apps: beta4.url } }),
        };
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Protocol two ${randomUUID().slice(0, 8)}`,
          files: [...catalogs("first", upstream.url), pinned],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        expect((yield* beta4.requests)[beta4.route]).toBeGreaterThan(0);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const path = `${prefix}/apps/${app.id}`;
        const call = (tool: string, input: Record<string, string>, kind?: "query" | "mutation") =>
          api.request(actors.owner, "POST", `${path}/tools/call`, {
            tool,
            input,
            ...(kind === undefined ? {} : { kind }),
          });
        expect((yield* call("mutations.save", { text: "before" }, "mutation")).body).toBe(
          "protocol 2",
        );

        // The host restarts and loads the retained build again, without rebuilding it.
        yield* serverControl("restart");

        const catalog = yield* body(
          Catalog,
          yield* api.request(actors.owner, "GET", `${path}/tools`),
        );
        expect(catalog.items.map((tool) => [tool.name, tool.readOnly]).toSorted()).toEqual([
          ["mutations.save", false],
          ["queries.notes", true],
        ]);
        expect(catalog.routers).toEqual([]);
        expect((yield* call("queries.notes", {})).body).toEqual(["before"]);
        expect((yield* call("queries.notes", {}, "query")).body).toEqual(["before"]);
        expect((yield* call("mutations.save", { text: "inferred" })).body).toBe("protocol 2");
        expect((yield* call("mutations.save", { text: "named" }, "mutation")).body).toBe(
          "protocol 2",
        );
        // A wrong kind is refused before the bundle runs, so nothing is written.
        const mismatch = yield* call("mutations.save", { text: "never" }, "query");
        expect(mismatch.status).toBe(409);
        expect(mismatch.body).toMatchObject({
          _tag: "ToolKindMismatch",
          requested: "query",
          actual: "mutation",
        });
        expect((yield* call("queries.notes", {})).body).toEqual(["before", "inferred", "named"]);

        // Workflow steps from the protocol-2 bundle name operations without their kind prefix.
        const started = yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
          workflow: "record",
          input: { text: "workflow" },
          key: randomUUID(),
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const run = yield* body(Schema.Struct({ id: Schema.String }), started);
        const completed = yield* eventually(
          api.request(actors.owner, "GET", `${path}/workflow-runs/${run.id}`).pipe(
            Effect.flatMap((response) => body(WorkflowRun, response)),
            Effect.flatMap((run) =>
              ["queued", "running", "waiting"].includes(run.status)
                ? Effect.fail(new Pending())
                : Effect.succeed(run),
            ),
          ),
        );
        expect(completed).toEqual({
          status: "complete",
          output: ["before", "inferred", "named", "workflow"],
        });

        // Protocol 2 reports that its skill loader read through the app cache, so the host keeps
        // the catalog: the next read does not contact the publisher.
        const skills = api
          .request(actors.owner, "GET", `${path}/skill-bundle`)
          .pipe(Effect.flatMap((response) => body(Bundle, response)));
        const first = yield* skills;
        expect(first.skills.map((skill) => skill.name)).toContain("remote-guide");
        const loaded = (yield* upstream.requests).length;
        expect(loaded).toBeGreaterThan(0);
        expect(yield* skills).toEqual(first);
        expect((yield* upstream.requests).length).toBe(loaded);

        // Agents search and call the old names through MCP.
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Protocol two",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "app-protocol-2", {
          organization: actors.organization.id,
        });
        const execute = (label: string, code: string) =>
          client
            .use(label, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Executed)(result.structuredContent),
              ),
            );
        const search = yield* execute(
          "Search the protocol-2 app",
          `return await tools.search({ query: "notes", namespace: ${JSON.stringify(app.slug)} });`,
        );
        expect(search.execution.ok).toBe(true);
        expect(
          (yield* Schema.decodeUnknownEffect(Search)(search.execution.value)).items.map(
            (item) => item.path,
          ),
        ).toEqual([`tools[${JSON.stringify(app.slug)}].queries.notes`]);
        const saved = yield* execute(
          "Call a protocol-2 mutation",
          `return await tools[${JSON.stringify(app.slug)}].mutations.save({ text: "agent" });`,
        );
        expect(saved.execution).toEqual({ ok: true, value: "protocol 2" });

        // Pinned to the bare published version, which hosts resolve from npm, the source rebuilds
        // and runs unchanged, and its data is kept.
        const rebuilt = yield* saveAndDeploy(actors.owner, path, {
          files: [
            ...catalogs("second", upstream.url),
            {
              path: "package.json",
              content: JSON.stringify({ dependencies: { apps: "0.0.1-beta.4" } }),
            },
          ],
        });
        expect(rebuilt.status, JSON.stringify(rebuilt.body)).toBe(200);
        expect((yield* call("mutations.save", { text: "rebuilt" })).body).toBe("protocol 2");
        expect((yield* call("queries.notes", {}, "query")).body).toEqual([
          "before",
          "inferred",
          "named",
          "workflow",
          "agent",
          "rebuilt",
        ]);
        expect((yield* skills).skills.map((skill) => skill.name)).toContain("remote-guide");
      }).pipe(Effect.provide(Layer.merge(McpOAuth.layer, McpClient.layer))),
    ),
  );
  it.effect(scenarios.appProtocol3.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const beta5 = yield* publishedRelease("0.0.1-beta.5");
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Protocol three ${randomUUID().slice(0, 8)}`,
          files: [
            ...detailed("first"),
            {
              path: "package.json",
              content: JSON.stringify({ dependencies: { apps: beta5.url } }),
            },
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        expect((yield* beta5.requests)[beta5.route]).toBeGreaterThan(0);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const path = `${prefix}/apps/${app.id}`;
        const call = (tool: string, input: Record<string, string>, kind?: "query" | "mutation") =>
          api.request(actors.owner, "POST", `${path}/tools/call`, {
            tool,
            input,
            ...(kind === undefined ? {} : { kind }),
          });
        expect((yield* call("mutations.save", { text: "before" }, "mutation")).body).toBe(
          "protocol 3",
        );

        // The host restarts and loads the retained build again, without rebuilding it.
        yield* serverControl("restart");

        const catalog = yield* body(
          Catalog,
          yield* api.request(actors.owner, "GET", `${path}/tools`),
        );
        expect(catalog.items.map((tool) => [tool.name, tool.readOnly]).toSorted()).toEqual([
          ["mutations.save", false],
          ["queries.fail", true],
          ["queries.notes", true],
        ]);
        expect(catalog.routers).toEqual([]);
        expect((yield* call("queries.notes", {})).body).toEqual(["before"]);
        expect((yield* call("queries.notes", {}, "query")).body).toEqual(["before"]);
        expect((yield* call("mutations.save", { text: "inferred" })).body).toBe("protocol 3");
        expect((yield* call("mutations.save", { text: "named" }, "mutation")).body).toBe(
          "protocol 3",
        );
        // A wrong kind is refused before the bundle runs, so nothing is written.
        const mismatch = yield* call("mutations.save", { text: "never" }, "query");
        expect(mismatch.status).toBe(409);
        expect(mismatch.body).toMatchObject({
          _tag: "ToolKindMismatch",
          requested: "query",
          actual: "mutation",
        });
        expect((yield* call("queries.notes", {})).body).toEqual(["before", "inferred", "named"]);

        // Protocol 3 carries the app's own error name and message, with or without a kind.
        for (const kind of [undefined, "query"] as const) {
          const failed = yield* call("queries.fail", {}, kind);
          expect(failed.status, JSON.stringify(failed.body)).toBe(502);
          expect((yield* body(ToolFailed, failed)).failure).toEqual({
            source: "app",
            errorName: "ConversationMissing",
            message: appMarker,
          });
        }

        // Workflow steps from the protocol-3 bundle name operations without their kind prefix,
        // and a failing step keeps the app's error.
        const settled = (workflow: string, input: Record<string, string>) =>
          Effect.gen(function* () {
            const started = yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
              workflow,
              input,
              key: randomUUID(),
            });
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const run = yield* body(Schema.Struct({ id: Schema.String }), started);
            return yield* eventually(
              api.request(actors.owner, "GET", `${path}/workflow-runs/${run.id}`).pipe(
                Effect.flatMap((response) => body(SettledRun, response)),
                Effect.flatMap((run) =>
                  ["queued", "running", "waiting"].includes(run.status)
                    ? Effect.fail(new Pending())
                    : Effect.succeed(run),
                ),
              ),
            );
          });
        expect(yield* settled("record", { text: "workflow" })).toEqual({
          status: "complete",
          output: ["before", "inferred", "named", "workflow"],
        });
        expect(yield* settled("broken", {})).toMatchObject({
          status: "errored",
          failure: { step: "explode", errorName: "ConversationMissing", message: appMarker },
        });

        // Pinned to the bare published version, which hosts resolve from npm, the source rebuilds
        // and runs unchanged, and its data is kept.
        const rebuilt = yield* saveAndDeploy(actors.owner, path, {
          files: [
            ...detailed("second"),
            {
              path: "package.json",
              content: JSON.stringify({ dependencies: { apps: "0.0.1-beta.5" } }),
            },
          ],
        });
        expect(rebuilt.status, JSON.stringify(rebuilt.body)).toBe(200);
        expect((yield* call("mutations.save", { text: "rebuilt" })).body).toBe("protocol 3");
        expect((yield* call("queries.notes", {}, "query")).body).toEqual([
          "before",
          "inferred",
          "named",
          "workflow",
          "rebuilt",
        ]);
        const rebuiltFailure = yield* call("queries.fail", {}, "query");
        expect((yield* body(ToolFailed, rebuiltFailure)).failure.errorName).toBe(
          "ConversationMissing",
        );
      }),
    ),
  );
});
