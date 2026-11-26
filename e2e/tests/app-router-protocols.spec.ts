import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
import { publishedRelease, type Release } from "../support/app-package.ts";
import { appsManifest, unscopedAccounts } from "../support/apps-release.ts";
import { credentialUpstream } from "../support/credential-upstream.ts";
import { connectionsPath, linkAccount } from "../support/app-accounts.ts";
import { serverControl } from "../support/server-control.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";

const health = (origin: string) => `health: async ({ account, fetch }) => {
    const response = await fetch(${JSON.stringify(`${origin}/health`)}, { headers: { authorization: "Bearer " + account.fields.token } });
    if (!response.ok) throw new Error("Health check failed: " + response.status);
  },`;

const notes = (
  framework: string,
) => `const database = defineDatabase({ notes: table({ text: string() }) });
const framework = () => (${framework});
const notes = query({ input: object({}) }, async ({ db }) => (await db.notes.withIndex("by_creation").collect()).map((row) => row.text));
const save = mutation({ input: object({ text: string() }) }, async ({ db }, input) => { await db.notes.insert(input); return framework(); });
const record = workflow({ input: object({ text: string() }) }, async (ctx, input) => {
  await ctx.step.runMutation("save", save, input);
  return ctx.step.runQuery("read", notes, {});
});`;

const send = `const send = async (url, token) => {
  const response = await fetch(url, { headers: { authorization: "Bearer " + token } });
  return { status: response.status, echoed: response.headers.get("x-echo-authorization") ?? "" };
};`;

const checked = (revision: string, origin: string) => [
  {
    path: "index.ts",
    content: `import * as apps from "apps";
import { defineApp, defineDatabase, defineProvider, secrets, table, query, mutation, workflow, object, string, router } from "apps";
// ${revision}
const service = defineProvider({
  name: "Protocol five service",
  auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) },
  ${health(origin)}
});
${notes('"plain" in apps ? "hosts" : "protocol 5"')}
export default defineApp({ accounts: { service }, database }, {
  tools: router({ notes, save }),
  workflows: { record },
});`,
  },
];

const sealed = (revision: string, name: string, host: string, origin: string) => [
  {
    path: "index.ts",
    content: `import * as apps from "apps";
import { defineApp, defineDatabase, defineProvider, secrets, table, query, mutation, workflow, object, string, plain, raw, router } from "apps";
// ${revision}
const service = defineProvider({
  name: ${JSON.stringify(name)},
  hosts: [${JSON.stringify(host)}],
  auth: { key: secrets({ label: "Key", fields: object({ region: plain(string()), token: string(), signing: raw(string()) }) }) },
  ${health(origin)}
});
${notes('"NetworkRefused" in apps ? "refusals" : "protocol 7"')}
${send}
const fields = query({ input: object({}) }, async (ctx) => ctx.accounts.service.fields);
const sendTo = query({ input: object({ url: string() }) }, async (ctx, { url }) => send(url, ctx.accounts.service.fields.token));
const stepped = workflow({ input: object({}) }, async (ctx) => ctx.step.do("fields", async (step) => step.accounts.service.fields));
export default defineApp({ accounts: { service }, database }, {
  tools: router({ notes, save, fields, send: sendTo }),
  workflows: { record, stepped },
});`,
  },
];

const appMarker = "Synthetic spec is missing its paths";
const statedMarker = "Synthetic token belongs to another organization";

const detailed = (revision: string) => [
  {
    path: "index.ts",
    content: `import * as apps from "apps";
import { defineApp, defineDatabase, table, query, mutation, workflow, object, string, router, ProviderError } from "apps";
// ${revision}
class SpecInvalid extends Error {
  constructor(message) { super(message); this.name = "SpecInvalid"; this.code = "spec_invalid"; this.pointer = "/paths"; this.attempts = 2; }
}
${notes('"table" in apps ? "protocol 8" : "sql"')}
const fail = query({ input: object({}) }, async () => { throw new SpecInvalid(${JSON.stringify(appMarker)}); });
const stated = query({ input: object({}) }, async () => {
  throw new ProviderError({ reason: "rejected", status: 403, phase: "call", upstream: { code: "invalid_token", message: ${JSON.stringify(statedMarker)} } });
});
const broken = workflow({ input: object({}) }, async (ctx) =>
  ctx.step.runQuery("explode", fail, {}, { retries: { limit: 0, delay: 0 } }));
export default defineApp({ accounts: {}, database }, {
  tools: router({ notes, save, fail, stated }),
  workflows: { record, broken },
});`,
  },
];

const credentialApp = (name: string, host: string | null, workflows: boolean) => {
  const source = credentialSource(name, host, workflows);
  return host === null ? unscopedAccounts(source) : source;
};
const credentialSource = (
  name: string,
  host: string | null,
  workflows: boolean,
) => `import { defineApp, defineProvider, secrets, object, string, query, workflow, router } from "apps";
const service = defineProvider({
  name: ${JSON.stringify(name)},
${host === null ? "" : `  hosts: [${JSON.stringify(host)}],\n`}
  auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) },
});
${send}
export default defineApp({ user: { accounts: { service } } }, {
  tools: router({
    fields: query({ input: object({}) }, async (ctx) => ctx.user.accounts.service.fields),
    send: query({ input: object({ url: string() }) }, async (ctx, { url }) => send(url, ctx.user.accounts.service.fields.token)),
  }),${
    workflows
      ? `
  workflows: { fields: workflow({ input: object({}) }, async (ctx) => ctx.step.do("fields", async (step) => step.user.accounts.service.fields)) },`
      : ""
  }
});`;

const App = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Record(
      Schema.String,
      Schema.Struct({ provider: Schema.String, health: Schema.optional(Schema.Literal(true)) }),
    ),
  }),
});
const Catalog = Schema.Struct({
  items: Schema.Array(Schema.Struct({ name: Schema.String, readOnly: Schema.Boolean })),
  routers: Schema.Array(Schema.Unknown),
});
const Run = Schema.Struct({
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
    code: Schema.optional(Schema.String),
    message: Schema.String,
    fields: Schema.optional(
      Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
    ),
  }),
});
const ProviderFailed = Schema.Struct({
  _tag: Schema.Literal("AppProviderFailed"),
  reason: Schema.String,
  status: Schema.Number,
  phase: Schema.optional(Schema.String),
  upstream: Schema.optional(
    Schema.Struct({
      code: Schema.Union([Schema.String, Schema.Number]),
      message: Schema.optional(Schema.String),
    }),
  ),
});
const Executed = Schema.Struct({
  execution: Schema.Struct({ ok: Schema.Boolean, value: Schema.optional(Schema.Unknown) }),
});
const Search = Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) });
const CredentialCheck = Schema.Struct({ status: Schema.String });
const Health = Schema.Struct({
  apps: Schema.Array(
    Schema.Struct({
      app: Schema.String,
      checkable: Schema.Boolean,
      check: Schema.NullOr(Schema.Struct({ status: Schema.String })),
    }),
  ),
});
const Token = Schema.Struct({ token: Schema.String });
const Fields = Schema.Struct({
  region: Schema.String,
  token: Schema.String,
  signing: Schema.String,
});
const Sent = Schema.Struct({ status: Schema.Number, echoed: Schema.String });
const handle = /^exsec_[0-9a-f]+_$/;
class Pending extends Schema.TaggedError<Pending>()("Pending", {}) {}

const harness = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    mcp = yield* McpClient;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const pinnedTo = (apps: string) => ({
    path: "package.json",
    content: JSON.stringify({ dependencies: { apps } }),
  });
  const deploy = (
    name: string,
    files: readonly { readonly path: string; readonly content: string }[],
  ) =>
    Effect.gen(function* () {
      const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name: `${name} ${randomUUID().slice(0, 8)}`,
        files,
      });
      expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
      const app = yield* body(App, deployed);
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
      );
      return { app, path: `${prefix}/apps/${app.id}` };
    });
  const call = (
    path: string,
    tool: string,
    input: Record<string, string>,
    options: { readonly kind?: "query" | "mutation" } = {},
  ) =>
    api.request(actors.owner, "POST", `${path}/tools/call`, {
      tool,
      input,
      ...(options.kind === undefined ? {} : { kind: options.kind }),
    });
  const result = <A>(
    path: string,
    output: Schema.Decoder<A>,
    tool: string,
    input: Record<string, string>,
    options: { readonly kind?: "query" | "mutation" } = {},
  ) =>
    Effect.gen(function* () {
      const response = yield* call(path, tool, input, options);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return yield* body(output, response);
    });
  const catalog = (path: string) =>
    api
      .request(actors.owner, "GET", `${path}/tools`)
      .pipe(Effect.flatMap((response) => body(Catalog, response)));
  const settled = (path: string, workflow: string, input: Record<string, string>) =>
    Effect.gen(function* () {
      const started = yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
        workflow,
        input,
        key: randomUUID(),
      });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const run = yield* body(Resource, started);
      return yield* api.request(actors.owner, "GET", `${path}/workflow-runs/${run.id}`).pipe(
        Effect.flatMap((response) => body(Run, response)),
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
    });
  const check = (path: string, provider: string, fields: Record<string, string>) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "POST", `${path}/credential-checks`, {
        provider,
        method: "key",
        fields,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return yield* body(CredentialCheck, response);
    });
  const connect = (path: string, label: string, fields: Record<string, string>) =>
    Effect.gen(function* () {
      const pending = yield* api.request(
        actors.owner,
        "POST",
        connectionsPath(path, "user", "service"),
        {},
      );
      expect(pending.status, JSON.stringify(pending.body)).toBe(200);
      const saved = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${(yield* body(Resource, pending)).id}/submit`,
        { method: "key", label, fields },
      );
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const account = (yield* body(Resource, saved)).id;
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
      );
      return account;
    });
  const link = (path: string, account: string) =>
    linkAccount(actors.owner, path, "service", account);
  const accountHealth = (account: string, app: string) =>
    Effect.gen(function* () {
      const response = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/accounts/${account}/health`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const entry = (yield* body(Health, response)).apps.find((item) => item.app === app);
      expect(entry, "The app checks the account").toMatchObject({ checkable: true });
      return entry?.check?.status;
    });
  const agent = (label: string, slug: string) =>
    Effect.gen(function* () {
      const key = yield* body(
        Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
        yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", { name: label }),
      );
      yield* Effect.addFinalizer(() =>
        api
          .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
          .pipe(Effect.orDie),
      );
      const client = yield* mcp.connect(key.key, label, { organization: actors.organization.id });
      const execute = (step: string, code: string) =>
        client
          .use(step, (client, signal) =>
            client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
          )
          .pipe(
            Effect.flatMap((result) =>
              Schema.decodeUnknownEffect(Executed)(result.structuredContent),
            ),
          );
      const namespace = `tools[${JSON.stringify(slug)}]`;
      const search = yield* execute(
        `Search the ${label} app`,
        `return await tools.search({ query: "notes", namespace: ${JSON.stringify(slug)} });`,
      );
      expect(search.execution.ok, JSON.stringify(search)).toBe(true);
      expect(
        (yield* Schema.decodeUnknownEffect(Search)(search.execution.value)).items.map(
          (item) => item.path,
        ),
      ).toContain(`${namespace}.notes`);
      return yield* execute(
        `Call a ${label} mutation`,
        `return await ${namespace}.save({ text: "agent" });`,
      );
    });
  return {
    actors,
    pinnedTo,
    deploy,
    call,
    result,
    catalog,
    settled,
    check,
    connect,
    link,
    accountHealth,
    agent,
  };
});

const deployPinned = (
  name: string,
  version: Release,
  files: readonly { readonly path: string; readonly content: string }[],
) =>
  Effect.gen(function* () {
    const { deploy, pinnedTo } = yield* harness;
    const release = yield* publishedRelease(version);
    const deployed = yield* deploy(name, [...files, pinnedTo(release.url)]);
    expect((yield* release.requests)[release.route]).toBeGreaterThan(0);
    return deployed;
  });

const synthetic = () => ({
  region: "synthetic-region",
  token: `synthetic-token-${randomUUID()}`,
  signing: `synthetic-signing-${randomUUID()}`,
});

layer(HostedLive, { excludeTestServices: true })(
  "Router apps from before the live protocol",
  (it) => {
    it.effect(scenarios.appProtocol5.title, (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const {
            actors,
            pinnedTo,
            call,
            result,
            catalog,
            settled,
            check,
            connect,
            accountHealth,
            agent,
          } = yield* harness;
          const upstream = yield* credentialUpstream;
          const { app, path } = yield* deployPinned(
            "Protocol five",
            "0.0.1-beta.14",
            checked("first", upstream.origin),
          );
          const provider = app.requirements.accounts.service;
          expect(provider?.health).toBe(true);
          const token = `synthetic-token-${randomUUID()}`;
          expect(yield* check(path, provider!.provider, { token })).toEqual({ status: "healthy" });
          const account = yield* connect(path, "Protocol five", { token });
          expect(yield* accountHealth(account, app.id)).toBe("healthy");
          expect(
            (yield* upstream.received)
              .filter((entry) => entry.url.includes("/health"))
              .map((entry) => entry.authorization),
          ).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
          const call5 = (
            tool: string,
            input: Record<string, string>,
            kind?: "query" | "mutation",
          ) => call(path, tool, input, kind === undefined ? {} : { kind });
          expect((yield* call5("save", { text: "before" }, "mutation")).body).toBe("protocol 5");

          yield* serverControl("restart");

          const listed = yield* catalog(path);
          expect(listed.items.map((tool) => [tool.name, tool.readOnly]).toSorted()).toEqual([
            ["notes", true],
            ["save", false],
          ]);
          expect(listed.routers).toEqual([]);
          expect((yield* call5("notes", {})).body).toEqual(["before"]);
          expect((yield* call5("notes", {}, "query")).body).toEqual(["before"]);
          expect((yield* call5("save", { text: "inferred" })).body).toBe("protocol 5");
          expect((yield* call5("save", { text: "named" }, "mutation")).body).toBe("protocol 5");
          const mismatch = yield* call5("save", { text: "never" }, "query");
          expect(mismatch.status).toBe(409);
          expect(mismatch.body).toMatchObject({
            _tag: "ToolKindMismatch",
            requested: "query",
            actual: "mutation",
          });
          expect((yield* call5("notes", {})).body).toEqual(["before", "inferred", "named"]);

          expect(yield* settled(path, "record", { text: "workflow" })).toEqual({
            status: "complete",
            output: ["before", "inferred", "named", "workflow"],
          });

          expect(yield* accountHealth(account, app.id)).toBe("healthy");

          expect((yield* agent("app-protocol-5", app.slug)).execution).toEqual({
            ok: true,
            value: "protocol 5",
          });

          const rebuilt = yield* saveAndDeploy(actors.owner, path, {
            files: [...checked("second", upstream.origin), pinnedTo("0.0.1-beta.14")],
          });
          expect(rebuilt.status, JSON.stringify(rebuilt.body)).toBe(200);
          expect((yield* call5("save", { text: "rebuilt" })).body).toBe("protocol 5");
          expect(
            yield* result(path, Schema.Array(Schema.String), "notes", {}, { kind: "query" }),
          ).toEqual(["before", "inferred", "named", "workflow", "agent", "rebuilt"]);
          expect(yield* accountHealth(account, app.id)).toBe("healthy");
        }).pipe(Effect.provide(Layer.merge(McpOAuth.layer, McpClient.layer))),
      ),
    );

    it.effect(scenarios.appProtocol7.title, (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const {
            actors,
            pinnedTo,
            call,
            result,
            catalog,
            settled,
            check,
            connect,
            accountHealth,
            agent,
          } = yield* harness;
          const upstream = yield* credentialUpstream;
          const host = `127.0.0.1:${upstream.port}`;
          const name = `Protocol seven service ${randomUUID().slice(0, 8)}`;
          const { app, path } = yield* deployPinned(
            "Protocol seven",
            "0.0.1-beta.22",
            sealed("first", name, host, upstream.origin),
          );
          const values = synthetic();
          const provider = app.requirements.accounts.service;
          expect(provider?.health).toBe(true);
          expect(yield* check(path, provider!.provider, values)).toEqual({ status: "healthy" });
          const account = yield* connect(path, name, values);
          const call7 = (
            tool: string,
            input: Record<string, string>,
            kind?: "query" | "mutation",
          ) => call(path, tool, input, kind === undefined ? {} : { kind });
          expect((yield* call7("save", { text: "before" }, "mutation")).body).toBe("protocol 7");

          yield* serverControl("restart");

          const listed = yield* catalog(path);
          expect(listed.items.map((tool) => [tool.name, tool.readOnly]).toSorted()).toEqual([
            ["fields", true],
            ["notes", true],
            ["save", false],
            ["send", true],
          ]);
          expect(listed.routers).toEqual([]);
          expect((yield* call7("notes", {})).body).toEqual(["before"]);
          expect((yield* call7("notes", {}, "query")).body).toEqual(["before"]);
          expect((yield* call7("save", { text: "inferred" })).body).toBe("protocol 7");
          expect((yield* call7("save", { text: "named" }, "mutation")).body).toBe("protocol 7");
          const mismatch = yield* call7("save", { text: "never" }, "query");
          expect(mismatch.status).toBe(409);
          expect(mismatch.body).toMatchObject({ _tag: "ToolKindMismatch", actual: "mutation" });

          const fields = yield* result(path, Fields, "fields", {});
          expect(fields.region).toBe(values.region);
          expect(fields.signing).toBe(values.signing);
          expect(fields.token).toMatch(handle);
          const stepped = yield* settled(path, "stepped", {});
          expect(stepped.status).toBe("complete");
          expect(Schema.decodeUnknownSync(Fields)(stepped.output).token).toMatch(handle);
          const sent = yield* result(path, Sent, "send", { url: `${upstream.origin}/sent` });
          expect(sent.status).toBe(200);
          expect(sent.echoed).toMatch(/^Bearer exsec_[0-9a-f]+_$/);
          const refused = yield* result(path, Sent, "send", {
            url: `${upstream.undeclaredOrigin}/undeclared`,
          });
          expect(refused.status).toBe(421);
          const received = yield* upstream.received;
          expect(received.filter((entry) => entry.url.includes("/undeclared"))).toEqual([]);
          expect(
            received
              .filter((entry) => /\/health|\/sent/.test(entry.url))
              .map((entry) => entry.authorization),
          ).toEqual([`Bearer ${values.token}`, `Bearer ${values.token}`]);
          expect(JSON.stringify([fields, stepped, sent])).not.toContain(values.token);

          expect(yield* settled(path, "record", { text: "workflow" })).toEqual({
            status: "complete",
            output: ["before", "inferred", "named", "workflow"],
          });
          expect(yield* accountHealth(account, app.id)).toBe("healthy");

          expect((yield* agent("app-protocol-7", app.slug)).execution).toEqual({
            ok: true,
            value: "protocol 7",
          });

          const rebuilt = yield* saveAndDeploy(actors.owner, path, {
            files: [...sealed("second", name, host, upstream.origin), pinnedTo("0.0.1-beta.22")],
          });
          expect(rebuilt.status, JSON.stringify(rebuilt.body)).toBe(200);
          expect((yield* call7("save", { text: "rebuilt" })).body).toBe("protocol 7");
          expect(
            yield* result(path, Schema.Array(Schema.String), "notes", {}, { kind: "query" }),
          ).toEqual(["before", "inferred", "named", "workflow", "agent", "rebuilt"]);
          expect((yield* result(path, Fields, "fields", {})).token).toMatch(handle);
        }).pipe(Effect.provide(Layer.merge(McpOAuth.layer, McpClient.layer))),
      ),
    );

    it.effect(scenarios.appProtocol8.title, (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const { actors, pinnedTo, call, result, catalog, settled, agent } = yield* harness;
          const { app, path } = yield* deployPinned(
            "Protocol eight",
            "0.0.1-beta.33",
            detailed("first"),
          );
          const call8 = (
            tool: string,
            input: Record<string, string>,
            kind?: "query" | "mutation",
          ) => call(path, tool, input, kind === undefined ? {} : { kind });
          expect((yield* call8("save", { text: "before" }, "mutation")).body).toBe("protocol 8");

          yield* serverControl("restart");

          const listed = yield* catalog(path);
          expect(listed.items.map((tool) => [tool.name, tool.readOnly]).toSorted()).toEqual([
            ["fail", true],
            ["notes", true],
            ["save", false],
            ["stated", true],
          ]);
          expect(listed.routers).toEqual([]);
          expect((yield* call8("notes", {})).body).toEqual(["before"]);
          expect((yield* call8("notes", {}, "query")).body).toEqual(["before"]);
          expect((yield* call8("save", { text: "inferred" })).body).toBe("protocol 8");
          expect((yield* call8("save", { text: "named" }, "mutation")).body).toBe("protocol 8");
          const mismatch = yield* call8("save", { text: "never" }, "query");
          expect(mismatch.status).toBe(409);
          expect(mismatch.body).toMatchObject({ _tag: "ToolKindMismatch", actual: "mutation" });

          for (const kind of [undefined, "query"] as const) {
            const failed = yield* call8("fail", {}, kind);
            expect(failed.status, JSON.stringify(failed.body)).toBe(502);
            const detail = yield* body(ToolFailed, failed);
            expect(detail.failure).toEqual({
              source: "app",
              errorName: "SpecInvalid",
              code: "spec_invalid",
              message: appMarker,
              fields: { pointer: "/paths", attempts: 2 },
            });
            expect(detail.reason).toBe(
              `The app threw SpecInvalid (spec_invalid): ${appMarker} Details: pointer: "/paths"; attempts: 2.`,
            );
          }
          const stated = yield* call8("stated", {}, "query");
          expect(stated.status, JSON.stringify(stated.body)).toBe(502);
          expect(yield* body(ProviderFailed, stated)).toMatchObject({
            reason: "rejected",
            status: 403,
            phase: "call",
            upstream: { code: "invalid_token", message: statedMarker },
          });

          expect(yield* settled(path, "record", { text: "workflow" })).toEqual({
            status: "complete",
            output: ["before", "inferred", "named", "workflow"],
          });
          expect(yield* settled(path, "broken", {})).toMatchObject({
            status: "errored",
            failure: { step: "explode", errorName: "SpecInvalid", message: appMarker },
          });

          expect((yield* agent("app-protocol-8", app.slug)).execution).toEqual({
            ok: true,
            value: "protocol 8",
          });

          const rebuilt = yield* saveAndDeploy(actors.owner, path, {
            files: [...detailed("second"), pinnedTo("0.0.1-beta.33")],
          });
          expect(rebuilt.status, JSON.stringify(rebuilt.body)).toBe(200);
          expect((yield* call8("save", { text: "rebuilt" })).body).toBe("protocol 8");
          expect(
            yield* result(path, Schema.Array(Schema.String), "notes", {}, { kind: "query" }),
          ).toEqual(["before", "inferred", "named", "workflow", "agent", "rebuilt"]);
          expect(
            (yield* body(ToolFailed, yield* call8("fail", {}, "query"))).failure.fields,
          ).toEqual({
            pointer: "/paths",
            attempts: 2,
          });
        }).pipe(Effect.provide(Layer.merge(McpOAuth.layer, McpClient.layer))),
      ),
    );

    it.effect(scenarios.appProtocol5Credentials.title, (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const { deploy, result, settled, connect, link } = yield* harness;
          const upstream = yield* credentialUpstream;
          const name = `Shared service ${randomUUID().slice(0, 8)}`;
          const current = yield* deploy("Current credentials", [
            { path: "index.ts", content: credentialApp(name, `127.0.0.1:${upstream.port}`, false) },
            appsManifest,
          ]);
          const older = yield* deployPinned("Protocol five credentials", "0.0.1-beta.14", [
            { path: "index.ts", content: credentialApp(name, null, true) },
          ]);
          const provider = current.app.requirements.accounts.service?.provider;
          expect(provider).toBeDefined();
          expect(older.app.requirements.accounts.service?.provider).toBe(provider);

          const token = `synthetic-token-${randomUUID()}`;
          const account = yield* connect(current.path, name, { token });
          const sealedToken = (yield* result(current.path, Token, "fields", {})).token;
          expect(sealedToken).toMatch(handle);
          const fromCurrent = yield* result(current.path, Sent, "send", {
            url: `${upstream.origin}/current`,
          });
          expect(fromCurrent.status).toBe(200);
          expect(fromCurrent.echoed).toMatch(/^Bearer exsec_[0-9a-f]+_$/);

          yield* link(older.path, account);
          const read = yield* result(older.path, Token, "fields", {});
          expect(read.token).toBe(token);
          const stepped = yield* settled(older.path, "fields", {});
          expect(stepped.status).toBe("complete");
          expect(stepped.output).toEqual({ token });
          const fromOlder = yield* result(older.path, Sent, "send", {
            url: `${upstream.origin}/older`,
          });
          expect(fromOlder.status).toBe(200);
          expect(fromOlder.echoed).toBe(`Bearer ${token}`);

          expect(
            (yield* upstream.received)
              .filter((entry) => /\/current|\/older/.test(entry.url))
              .map((entry) => [new URL(entry.url, upstream.origin).pathname, entry.authorization]),
          ).toEqual([
            ["/current", `Bearer ${token}`],
            ["/older", `Bearer ${token}`],
          ]);
        }).pipe(Effect.provide(Layer.merge(McpOAuth.layer, McpClient.layer))),
      ),
    );
  },
);
