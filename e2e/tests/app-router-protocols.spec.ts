/**
 * Builds of the router frameworks most live apps run keep working, unchanged, on the current host.
 * One app is pinned to the published `apps@0.0.1-beta.14` (protocol 5), another to the published
 * `apps@0.0.1-beta.22` (protocol 7), a third to the published `apps@0.0.1-beta.33` (protocol 8).
 * A fourth pairs a protocol-5 app with a current app of the same provider: the older bundle reads
 * real credential values, never the sealed handles the current app reads.
 */
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
import { appsManifest } from "../support/apps-release.ts";
import { credentialUpstream } from "../support/credential-upstream.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { serverControl } from "../support/server-control.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";

/** A provider check that reads `${origin}/health` with the account's token. */
const health = (origin: string) => `health: async ({ account, fetch }) => {
    const response = await fetch(${JSON.stringify(`${origin}/health`)}, { headers: { authorization: "Bearer " + account.fields.token } });
    if (!response.ok) throw new Error("Health check failed: " + response.status);
  },`;

/**
 * Notes in the document store every framework before SQL kept, a mutation that names the bundled
 * framework, and a workflow over both. `framework` tells the pinned release from a later one by an
 * export the later one added, or the pinned one dropped.
 */
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

/** Send the token as a bearer and return what the service echoed back. */
const send = `const send = async (url, token) => {
  const response = await fetch(url, { headers: { authorization: "Bearer " + token } });
  return { status: response.status, echoed: response.headers.get("x-echo-authorization") ?? "" };
};`;

/**
 * Single-file source written for `apps@0.0.1-beta.14`, protocol 5: a router, and a provider slot
 * whose check reads the service. `plain` arrived with credential hosts, two protocols later.
 */
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

/**
 * Single-file source written for `apps@0.0.1-beta.22`, protocol 7: a provider that declares the
 * host its token may go to, with a plain and a raw field, and tools that read and send the token.
 * `NetworkRefused` became an export one protocol later.
 */
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

/** The message a protocol-8 app's own error carries. */
const appMarker = "Synthetic spec is missing its paths";
/** The error a protocol-8 app reports a service stated. */
const statedMarker = "Synthetic token belongs to another organization";

/**
 * Single-file source written for `apps@0.0.1-beta.33`, protocol 8: a query that throws the app's
 * own error with a code and scalar fields, one that throws the error a service stated, and a
 * workflow step over the first. The document store left the root export two protocols later.
 */
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

/**
 * Two apps of one provider: the current framework's declares the host its token may go to, the
 * protocol-5 framework's knows no hosts. Both read the token and send it as a bearer.
 */
const credentialApp = (
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
export default defineApp({ accounts: { service } }, {
  tools: router({
    fields: query({ input: object({}) }, async (ctx) => ctx.accounts.service.fields),
    send: query({ input: object({ url: string() }) }, async (ctx, { url }) => send(url, ctx.accounts.service.fields.token)),
  }),${
    workflows
      ? `
  workflows: { fields: workflow({ input: object({}) }, async (ctx) => ctx.step.do("fields", async (step) => step.accounts.service.fields)) },`
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

/** The real API, with each app, account and key deleted when the case ends. */
const harness = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    mcp = yield* McpClient;
  const prefix = `/api/organizations/${actors.organization.id}`;
  /** A `package.json` pinning `apps` to a published release served on loopback, or by name. */
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
  /** Call a tool, naming its kind or leaving the host to find it, in a profile or without one. */
  const call = (
    path: string,
    tool: string,
    input: Record<string, string>,
    options: { readonly kind?: "query" | "mutation"; readonly profile?: string } = {},
  ) =>
    api.request(actors.owner, "POST", `${path}/tools/call`, {
      tool,
      input,
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
    });
  /** Call a tool that must succeed and decode its result. */
  const result = <A>(
    path: string,
    output: Schema.Decoder<A>,
    tool: string,
    input: Record<string, string>,
    options: { readonly kind?: "query" | "mutation"; readonly profile?: string } = {},
  ) =>
    Effect.gen(function* () {
      const response = yield* call(path, tool, input, options);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return yield* body(output, response);
    });
  const catalog = (path: string, profile?: string) =>
    api
      .request(
        actors.owner,
        "GET",
        `${path}/tools${profile === undefined ? "" : `?profile=${profile}`}`,
      )
      .pipe(Effect.flatMap((response) => body(Catalog, response)));
  /** Start a workflow run and wait until it settles. */
  const settled = (
    path: string,
    workflow: string,
    input: Record<string, string>,
    profile?: string,
  ) =>
    Effect.gen(function* () {
      const started = yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
        workflow,
        input,
        key: randomUUID(),
        ...(profile === undefined ? {} : { profile }),
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
  /** Check credentials before they are saved, as the connect form's Validate button does. */
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
  /** Connect one account through a fresh profile of the app, which selects it. */
  const connect = (path: string, label: string, fields: Record<string, string>) =>
    Effect.gen(function* () {
      const profile = yield* createProfile(actors.owner, path);
      const pending = yield* api.request(actors.owner, "POST", `${path}/connections`, {
        requirement: "service",
        profile: profile.id,
      });
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
      return { profile: profile.id, account };
    });
  /** Select an existing account in a fresh profile of another app. */
  const select = (path: string, account: string) =>
    Effect.gen(function* () {
      const profile = yield* createProfile(actors.owner, path);
      const selected = yield* selectProfileAccounts(actors.owner, path, profile.id, {
        service: account,
      });
      expect(selected.status, JSON.stringify(selected.body)).toBe(200);
      return profile.id;
    });
  /** Check a saved account with every app that can, and return the status this app reported. */
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
  /**
   * An agent searches and calls the app through MCP with a real API key. An app with accounts is
   * addressed through the profile that selects them.
   */
  const agent = (label: string, slug: string, profile?: string) =>
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
      const namespace =
        profile === undefined
          ? `tools[${JSON.stringify(slug)}]`
          : `tools[${JSON.stringify(slug)}].profiles[${JSON.stringify(profile)}]`;
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
    select,
    accountHealth,
    agent,
  };
});

/** Deploy `files` pinned to a published release served on loopback, and record that it was read. */
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
          // The host's account check runs against the protocol-5 bundle: before the credentials are
          // saved, and again for the saved account. Protocol 5 knows no hosts, so the check sends
          // the real token.
          const provider = app.requirements.accounts.service;
          expect(provider?.health).toBe(true);
          const token = `synthetic-token-${randomUUID()}`;
          expect(yield* check(path, provider!.provider, { token })).toEqual({ status: "healthy" });
          const { profile, account } = yield* connect(path, "Protocol five", { token });
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
          ) => call(path, tool, input, { profile, ...(kind === undefined ? {} : { kind }) });
          expect((yield* call5("save", { text: "before" }, "mutation")).body).toBe("protocol 5");

          // The host restarts and loads the retained build again, without rebuilding it.
          yield* serverControl("restart");

          const listed = yield* catalog(path, profile);
          expect(listed.items.map((tool) => [tool.name, tool.readOnly]).toSorted()).toEqual([
            ["notes", true],
            ["save", false],
          ]);
          expect(listed.routers).toEqual([]);
          expect((yield* call5("notes", {})).body).toEqual(["before"]);
          expect((yield* call5("notes", {}, "query")).body).toEqual(["before"]);
          expect((yield* call5("save", { text: "inferred" })).body).toBe("protocol 5");
          expect((yield* call5("save", { text: "named" }, "mutation")).body).toBe("protocol 5");
          // A wrong kind is refused before the bundle runs, so nothing is written.
          const mismatch = yield* call5("save", { text: "never" }, "query");
          expect(mismatch.status).toBe(409);
          expect(mismatch.body).toMatchObject({
            _tag: "ToolKindMismatch",
            requested: "query",
            actual: "mutation",
          });
          expect((yield* call5("notes", {})).body).toEqual(["before", "inferred", "named"]);

          // Workflow steps from the protocol-5 bundle carry their kind.
          expect(yield* settled(path, "record", { text: "workflow" }, profile)).toEqual({
            status: "complete",
            output: ["before", "inferred", "named", "workflow"],
          });

          // The saved account is still checked by the retained build.
          expect(yield* accountHealth(account, app.id)).toBe("healthy");

          // Agents search and call the app through MCP.
          expect((yield* agent("app-protocol-5", app.slug, profile)).execution).toEqual({
            ok: true,
            value: "protocol 5",
          });

          // Pinned to the bare published version, which hosts resolve from npm, the source rebuilds
          // and runs unchanged, and its data is kept.
          const rebuilt = yield* saveAndDeploy(actors.owner, path, {
            files: [...checked("second", upstream.origin), pinnedTo("0.0.1-beta.14")],
          });
          expect(rebuilt.status, JSON.stringify(rebuilt.body)).toBe(200);
          expect((yield* call5("save", { text: "rebuilt" })).body).toBe("protocol 5");
          expect(
            yield* result(
              path,
              Schema.Array(Schema.String),
              "notes",
              {},
              { profile, kind: "query" },
            ),
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
          // The account check runs before the account is saved, through the same outbound network.
          expect(yield* check(path, provider!.provider, values)).toEqual({ status: "healthy" });
          const { profile, account } = yield* connect(path, name, values);
          const call7 = (
            tool: string,
            input: Record<string, string>,
            kind?: "query" | "mutation",
          ) => call(path, tool, input, { profile, ...(kind === undefined ? {} : { kind }) });
          expect((yield* call7("save", { text: "before" }, "mutation")).body).toBe("protocol 7");

          // The host restarts and loads the retained build again, without rebuilding it.
          yield* serverControl("restart");

          const listed = yield* catalog(path, profile);
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

          // Protocol 7 declared hosts, so the bundle reads handles: the secret field is sealed, the
          // plain and raw fields keep their values, and a workflow step reads the same.
          const fields = yield* result(path, Fields, "fields", {}, { profile });
          expect(fields.region).toBe(values.region);
          expect(fields.signing).toBe(values.signing);
          expect(fields.token).toMatch(handle);
          const stepped = yield* settled(path, "stepped", {}, profile);
          expect(stepped.status).toBe("complete");
          expect(Schema.decodeUnknownSync(Fields)(stepped.output).token).toMatch(handle);
          // The outbound network replaces the handle on a request to the declared host, and the app
          // reads the echoed value as its handle again.
          const sent = yield* result(
            path,
            Sent,
            "send",
            { url: `${upstream.origin}/sent` },
            { profile },
          );
          expect(sent.status).toBe(200);
          expect(sent.echoed).toMatch(/^Bearer exsec_[0-9a-f]+_$/);
          // A host the provider does not declare is refused before anything is sent.
          const refused = yield* result(
            path,
            Sent,
            "send",
            { url: `${upstream.undeclaredOrigin}/undeclared` },
            { profile },
          );
          expect(refused.status).toBe(421);
          const received = yield* upstream.received;
          expect(received.filter((entry) => entry.url.includes("/undeclared"))).toEqual([]);
          expect(
            received
              .filter((entry) => /\/health|\/sent/.test(entry.url))
              .map((entry) => entry.authorization),
          ).toEqual([`Bearer ${values.token}`, `Bearer ${values.token}`]);
          expect(JSON.stringify([fields, stepped, sent])).not.toContain(values.token);

          expect(yield* settled(path, "record", { text: "workflow" }, profile)).toEqual({
            status: "complete",
            output: ["before", "inferred", "named", "workflow"],
          });
          expect(yield* accountHealth(account, app.id)).toBe("healthy");

          // Agents search and call the app through MCP.
          expect((yield* agent("app-protocol-7", app.slug, profile)).execution).toEqual({
            ok: true,
            value: "protocol 7",
          });

          // Pinned to the bare published version, the source rebuilds and runs unchanged.
          const rebuilt = yield* saveAndDeploy(actors.owner, path, {
            files: [...sealed("second", name, host, upstream.origin), pinnedTo("0.0.1-beta.22")],
          });
          expect(rebuilt.status, JSON.stringify(rebuilt.body)).toBe(200);
          expect((yield* call7("save", { text: "rebuilt" })).body).toBe("protocol 7");
          expect(
            yield* result(
              path,
              Schema.Array(Schema.String),
              "notes",
              {},
              { profile, kind: "query" },
            ),
          ).toEqual(["before", "inferred", "named", "workflow", "agent", "rebuilt"]);
          expect((yield* result(path, Fields, "fields", {}, { profile })).token).toMatch(handle);
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

          // The host restarts and loads the retained build again, without rebuilding it.
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

          // Protocol 8 carries the thrown error's code and scalar fields to the caller.
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
          // And the error a service stated, with the phase the app named.
          const stated = yield* call8("stated", {}, "query");
          expect(stated.status, JSON.stringify(stated.body)).toBe(502);
          expect(yield* body(ProviderFailed, stated)).toMatchObject({
            reason: "rejected",
            status: 403,
            phase: "call",
            upstream: { code: "invalid_token", message: statedMarker },
          });

          // Workflow steps carry their kind, and a failing step keeps the app's error.
          expect(yield* settled(path, "record", { text: "workflow" })).toEqual({
            status: "complete",
            output: ["before", "inferred", "named", "workflow"],
          });
          expect(yield* settled(path, "broken", {})).toMatchObject({
            status: "errored",
            failure: { step: "explode", errorName: "SpecInvalid", message: appMarker },
          });

          // Agents search and call the app through MCP.
          expect((yield* agent("app-protocol-8", app.slug)).execution).toEqual({
            ok: true,
            value: "protocol 8",
          });

          // Pinned to the bare published version, the source rebuilds and runs unchanged.
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
          const { deploy, result, settled, connect, select } = yield* harness;
          const upstream = yield* credentialUpstream;
          const name = `Shared service ${randomUUID().slice(0, 8)}`;
          // One provider in two apps: the current framework's declares the host its token may go
          // to; the protocol-5 framework's knows no hosts.
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

          // Connected through the current app, the account records the hosts it may be sent to.
          const token = `synthetic-token-${randomUUID()}`;
          const { profile, account } = yield* connect(current.path, name, { token });
          const sealedToken = (yield* result(current.path, Token, "fields", {}, { profile })).token;
          expect(sealedToken).toMatch(handle);
          const fromCurrent = yield* result(
            current.path,
            Sent,
            "send",
            { url: `${upstream.origin}/current` },
            { profile },
          );
          expect(fromCurrent.status).toBe(200);
          expect(fromCurrent.echoed).toMatch(/^Bearer exsec_[0-9a-f]+_$/);

          // The same account selected into the protocol-5 app reaches its code as the real value:
          // a bundle from before credential hosts would read a handle as the secret.
          const olderProfile = yield* select(older.path, account);
          const read = yield* result(older.path, Token, "fields", {}, { profile: olderProfile });
          expect(read.token).toBe(token);
          const stepped = yield* settled(older.path, "fields", {}, olderProfile);
          expect(stepped.status).toBe("complete");
          expect(stepped.output).toEqual({ token });
          const fromOlder = yield* result(
            older.path,
            Sent,
            "send",
            { url: `${upstream.origin}/older` },
            { profile: olderProfile },
          );
          expect(fromOlder.status).toBe(200);
          expect(fromOlder.echoed).toBe(`Bearer ${token}`);

          // Both apps sent the real value to the declared host.
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
