/**
 * A provider that declares hosts never gives app code its secret values. App code reads handles,
 * the app's outbound network substitutes the real values only on requests to those hosts, and a
 * value the service echoes is returned to the app as its handle. `plain()` and `raw()` fields
 * keep their real values.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { appsManifest, databaseFiles, withApps, mcpDependencies } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { credentialUpstream, ReceivedRequest } from "../support/credential-upstream.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Record(Schema.String, Schema.Struct({ provider: Schema.String })),
  }),
});
const CredentialCheck = Schema.Struct({ status: Schema.String });
const Fields = Schema.Struct({
  region: Schema.String,
  token: Schema.String,
  signing: Schema.String,
});
const ApiKey = Schema.Struct({ id: Schema.String, key: Schema.NonEmptyString });
const Run = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  output: Schema.optionalKey(Schema.Json),
});
const Sent = Schema.Struct({ status: Schema.Number, echoed: Schema.String, text: Schema.String });
const ToolFailed = Schema.Struct({
  _tag: Schema.Literal("ToolCallFailed"),
  reason: Schema.String,
  failure: Schema.Struct({
    source: Schema.String,
    errorName: Schema.String,
    code: Schema.optional(Schema.String),
    message: Schema.String,
  }),
});
const Refusal = Schema.fromJsonString(
  Schema.Struct({
    _tag: Schema.Literal("NetworkRefused"),
    host: Schema.String,
    refusal: Schema.Struct({
      reason: Schema.Literal("credential_host"),
      provider: Schema.String,
      allowedHosts: Schema.Array(Schema.String),
    }),
    message: Schema.String,
  }),
);
const handle = /^exsec_[0-9a-f]+_$/;

/**
 * An app whose provider sends its token only to `host`. Its tools return the fields as app code
 * sees them, send the token in every placement the outbound rewrites, and send it to any URL.
 */
const credentialApp = (options: {
  readonly name: string;
  readonly host: string | readonly string[] | null;
  readonly health: string | null;
}) => `import { defineApp, defineProvider, secrets, object, string, plain, raw, query, router, workflow } from "apps";
const service = defineProvider({
  name: ${JSON.stringify(options.name)},
${options.host === null ? "" : `  hosts: ${JSON.stringify([options.host].flat())},\n`}
  auth: {
    key: secrets({
      label: "Key",
      fields: object({ region: plain(string()), token: string(), signing: raw(string()) }),
    }),
  },${
    options.health === null
      ? ""
      : `
  health: async ({ account, fetch }) => {
    const response = await fetch(${JSON.stringify(`${options.health}/health`)}, {
      headers: { authorization: "Bearer " + account.fields.token },
    });
    if (!response.ok) throw new Error("Health check failed: " + response.status);
  },`
  }
});
const send = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, echoed: response.headers.get("x-echo-authorization") ?? "", text: await response.text() };
};
export default defineApp({ accounts: { service } }, {
  // A workflow step reads its accounts through the run's own capability.
  workflows: { fields: workflow({ input: object({}) }, async (ctx) =>
    ctx.step.do("fields", async (step) => step.accounts.service.fields)) },
  tools: router({
    fields: query({ input: object({}) }, async (ctx) => ctx.accounts.service.fields),
    placements: query({ input: object({ origin: string() }) }, async (ctx, { origin }) => {
      const token = ctx.accounts.service.fields.token;
      return [
        await send(origin + "/query?key=" + encodeURIComponent(token), {
          headers: { authorization: "Bearer " + token, "x-api-key": token },
        }),
        await send(origin + "/json", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        }),
        await send(origin + "/form", { method: "POST", body: new URLSearchParams({ token }) }),
        await send(origin + "/basic", { headers: { authorization: "Basic " + btoa("user:" + token) } }),
      ];
    }),
    send: query({ input: object({ url: string() }) }, async (ctx, { url }) =>
      send(url, { headers: { authorization: "Bearer " + ctx.accounts.service.fields.token } })),
    fetchSend: query({ input: object({ url: string() }) }, async (ctx, { url }) => {
      const response = await ctx.fetch(url, { headers: { authorization: "Bearer " + ctx.accounts.service.fields.token } });
      return { status: response.status, echoed: "", text: await response.text() };
    }),
  }),
});`;

/**
 * An app whose tools come from an MCP server at `url`, sent the provider's token. Its provider
 * declares `host` only.
 */
const mcpApp = (options: { readonly name: string; readonly host: string; readonly url: string }) =>
  `import { defineApp, defineProvider, secrets, object, string, plain, raw } from "apps";
import { mcpRouter } from "apps/mcp";
const service = defineProvider({
  name: ${JSON.stringify(options.name)},
  hosts: ${JSON.stringify([options.host])},
  auth: {
    key: secrets({
      label: "Key",
      fields: object({ region: plain(string()), token: string(), signing: raw(string()) }),
    }),
  },
});
export default defineApp({ accounts: { service } }, async (ctx) => ({
  tools: await mcpRouter({
    url: ${JSON.stringify(options.url)},
    account: ctx.accounts.service,
    headers: { authorization: "Bearer " + ctx.accounts.service.fields.token },
    signal: ctx.signal,
  }),
}));`;

/** An app with no accounts that sends whatever credential it is given. */
const replayApp = `import { defineApp, object, string, query, router } from "apps";
export default defineApp({ accounts: {} }, {
  tools: router({
    send: query({ input: object({ url: string(), credential: string() }) }, async (_, { url, credential }) => {
      const response = await fetch(url, { headers: { authorization: "Bearer " + credential } });
      return { status: response.status, echoed: "", text: await response.text() };
    }),
  }),
});`;

const scenario = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const deploy = (name: string, content: string, manifest = appsManifest, database = false) =>
    Effect.gen(function* () {
      const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name,
        files: [{ path: "index.ts", content }, manifest, ...databaseFiles(database)],
      });
      expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
      const app = yield* body(App, deployed);
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
      );
      return { path: `${prefix}/apps/${app.id}`, app };
    });
  /** Check credentials before they are saved, as the connect form's Validate button does. */
  const check = (path: string, provider: string, fields: typeof Fields.Type) =>
    api
      .request(actors.owner, "POST", `${path}/credential-checks`, {
        provider,
        method: "key",
        fields,
      })
      .pipe(
        Effect.tap((response) =>
          Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
        ),
        Effect.flatMap((response) => body(CredentialCheck, response)),
      );
  /**
   * Select an existing account in a fresh profile of another app. Tool calls read the saved
   * selection, so nothing here waits for background profile setup: on a shared Cloud stage that
   * setup queues behind every other organization's.
   */
  const select = (path: string, account: string) =>
    Effect.gen(function* () {
      const profile = yield* createProfile(actors.owner, path);
      const selected = yield* selectProfileAccounts(actors.owner, path, profile.id, {
        service: account,
      });
      expect(selected.status, JSON.stringify(selected.body)).toBe(200);
      return profile.id;
    });
  /** Connect one account through a fresh profile, which selects it. */
  const connect = (path: string, label: string, fields: typeof Fields.Type) =>
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
  const call = <A>(
    path: string,
    output: Schema.Decoder<A>,
    tool: string,
    input: object,
    profile?: string,
  ) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
        ...(profile === undefined ? {} : { profile }),
        tool,
        input,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return yield* body(output, response);
    });
  /** Call a tool that must fail, and return the failure the caller receives. */
  const callFailure = (path: string, tool: string, input: object, profile: string) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
        profile,
        tool,
        input,
      });
      expect(response.status, JSON.stringify(response.body)).not.toBe(200);
      return yield* body(ToolFailed, response);
    });
  /** Run a workflow to completion and return its output. */
  const runWorkflow = (path: string, workflow: string, profile: string) =>
    Effect.gen(function* () {
      const started = yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
        profile,
        workflow,
        input: {},
        key: randomUUID(),
      });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const { id } = yield* body(Run, started);
      return yield* api.request(actors.owner, "GET", `${path}/workflow-runs/${id}`).pipe(
        Effect.flatMap((response) => body(Run, response)),
        Effect.flatMap((current) =>
          current.status === "complete"
            ? Effect.succeed(current.output)
            : ["errored", "terminated"].includes(current.status)
              ? Effect.die(new Error(JSON.stringify(current)))
              : Effect.fail(new Error("Workflow run has not finished")),
        ),
        Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 150 }),
      );
    });
  /** A real API key for the owner, deleted with the case. */
  const apiKey = Effect.gen(function* () {
    const created = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
      name: "Credential hosts",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const key = yield* body(ApiKey, created);
    yield* Effect.addFinalizer(() =>
      api
        .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
        .pipe(Effect.orDie),
    );
    return key.key;
  });
  return { actors, deploy, check, connect, select, call, callFailure, runWorkflow, apiKey };
});

const synthetic = () => ({
  region: "synthetic-region",
  token: `synthetic-token-${randomUUID()}`,
  signing: `synthetic-signing-${randomUUID()}`,
});

/**
 * The hosts the refusal checks name. On self-host the declared and the undeclared name both reach
 * a loopback receiver, which shows that a refused request sends nothing. Cloud app Workers refuse
 * private addresses before the credential check, so there the hosts are under the reserved
 * `.invalid` suffix: Executor treats them as public, and nothing could answer a request that
 * escaped the checks.
 */
const refusalHosts = Effect.gen(function* () {
  if ((yield* Target).metadata.target === "cloud")
    return {
      declaredHost: "api.credential-hosts.invalid",
      declaredOrigin: "https://api.credential-hosts.invalid",
      undeclaredOrigin: "https://undeclared.credential-hosts.invalid",
      received: null,
    };
  const upstream = yield* credentialUpstream;
  return {
    declaredHost: `127.0.0.1:${upstream.port}`,
    declaredOrigin: upstream.origin,
    undeclaredOrigin: upstream.undeclaredOrigin,
    received: upstream.received,
  };
});

layer(HostedLive, { excludeTestServices: true })("Credential hosts", (it) => {
  /**
   * Deploy an app whose provider `name` declares one of `hosts`, connect an account, and check that
   * app code reads handles and that an undeclared host is refused.
   */
  const sealedApp = (
    database: boolean,
    hosts: Effect.Success<typeof refusalHosts>,
    name = `Credential hosts ${randomUUID().slice(0, 8)}`,
  ) =>
    Effect.gen(function* () {
      const { deploy, connect, call, callFailure } = yield* scenario;
      const { declaredHost, undeclaredOrigin } = hosts;
      const values = synthetic();
      const { path } = yield* deploy(
        name,
        credentialApp({ name, host: declaredHost, health: null }),
        appsManifest,
        database,
      );
      const { profile, account } = yield* connect(path, name, values);

      // Secret fields are handles; plain and raw fields keep their values.
      const fields = yield* call(path, Fields, "fields", {}, profile);
      expect(fields.region).toBe(values.region);
      expect(fields.signing).toBe(values.signing);
      expect(fields.token).toMatch(handle);
      expect(JSON.stringify(fields)).not.toContain(values.token);

      // A host the provider does not declare is refused before anything is sent.
      const undeclared = yield* call(
        path,
        Sent,
        "send",
        { url: `${undeclaredOrigin}/undeclared` },
        profile,
      );
      expect(undeclared.status).toBe(421);
      const refusal = `Executor refused this request: ${name} credentials cannot be sent to ${new URL(undeclaredOrigin).host}. The provider allows: ${declaredHost}.`;
      expect(Schema.decodeUnknownSync(Refusal)(undeclared.text)).toEqual({
        _tag: "NetworkRefused",
        host: new URL(undeclaredOrigin).host,
        refusal: {
          reason: "credential_host",
          provider: name,
          allowedHosts: [declaredHost],
        },
        message: refusal,
      });
      // ctx.fetch rejects with the refusal, and the caller reads why: no service answered.
      const fetched = yield* callFailure(
        path,
        "fetchSend",
        { url: `${undeclaredOrigin}/fetched` },
        profile,
      );
      expect(fetched.failure).toEqual({
        source: "app",
        errorName: "NetworkRefused",
        code: "credential_host",
        message: refusal,
      });
      expect(fetched.reason).toBe(`The app threw NetworkRefused (credential_host): ${refusal}`);
      return { values, path, profile, account, refusal, sealed: fields.token };
    });

  it.effect(scenarios.credentialHostsRefused.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, call, runWorkflow, select } = yield* scenario;
        const api = yield* Api,
          actors = yield* Actors;
        const hosts = yield* refusalHosts;
        const name = `Credential hosts ${randomUUID().slice(0, 8)}`;
        // The replay and MCP apps do not depend on the sealed app, so all three deploy together.
        const [{ values, path, profile, account, refusal, sealed }, replay, mcp] =
          yield* Effect.all(
            [
              sealedApp(false, hosts, name),
              deploy(`Credential replay ${randomUUID().slice(0, 8)}`, replayApp),
              deploy(
                `Credential MCP ${randomUUID().slice(0, 8)}`,
                mcpApp({
                  name,
                  host: hosts.declaredHost,
                  url: `${hosts.undeclaredOrigin}/mcp`,
                }),
                {
                  path: "package.json",
                  content: JSON.stringify({
                    dependencies: withApps(mcpDependencies),
                  }),
                },
              ),
            ],
            { concurrency: "unbounded" },
          );

        yield* Effect.all(
          [
            // Workflow steps receive the same handles, never the stored value.
            Effect.gen(function* () {
              const stepped = Schema.decodeUnknownSync(Fields)(
                yield* runWorkflow(path, "fields", profile),
              );
              expect(stepped.token).toMatch(handle);
              expect(stepped.signing).toBe(values.signing);
            }),
            // Another app cannot send this app's handle, even to the declared host.
            Effect.gen(function* () {
              const replayed = yield* call(replay.path, Sent, "send", {
                url: `${hosts.declaredOrigin}/replayed`,
                credential: sealed,
              });
              expect(replayed.status).toBe(421);
              expect(replayed.text).toContain("not valid for this app");
            }),
            // A protocol helper reports the same refusal when its server is on an undeclared host.
            Effect.gen(function* () {
              const mcpProfile = yield* select(mcp.path, account);
              const listed = yield* api.request(
                actors.owner,
                "GET",
                `${mcp.path}/tools?profile=${mcpProfile}`,
              );
              expect(listed.status, JSON.stringify(listed.body)).not.toBe(200);
              expect(listed.body).toMatchObject({
                _tag: "AppEvaluationFailed",
                failure: {
                  source: "app",
                  errorName: "NetworkRefused",
                  code: "credential_host",
                  message: refusal,
                },
              });
            }),
          ],
          { concurrency: "unbounded", discard: true },
        );

        if (hosts.received !== null) {
          const received = yield* hosts.received;
          expect(
            received.filter((entry) => /undeclared|replayed|fetched|mcp/.test(entry.url)),
          ).toEqual([]);
          expect(JSON.stringify(received)).not.toContain(values.token);
        }
      }),
    ),
  );

  it.effect(scenarios.credentialHostsRefusedData.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        // Queries of an app with a database run in its data facet, which has its own outbound.
        const hosts = yield* refusalHosts;
        const { values } = yield* sealedApp(true, hosts);
        if (hosts.received !== null) {
          const received = yield* hosts.received;
          expect(received.filter((entry) => /undeclared|fetched/.test(entry.url))).toEqual([]);
          expect(JSON.stringify(received)).not.toContain(values.token);
        }
      }),
    ),
  );

  it.effect(scenarios.credentialHostsForm.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, deploy } = yield* scenario;
        const browser = yield* Browser;
        yield* browser.login(actors.owner);
        for (const host of ["api.example.com", null]) {
          const name = `Credential form ${randomUUID().slice(0, 8)}`;
          const { app } = yield* deploy(name, credentialApp({ name, host, health: null }));
          yield* browser.use("Open the app's accounts", (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
          );
          yield* browser.use("Connect a new account", (page) =>
            page.getByRole("button", { name: "Connect new account", exact: true }).click(),
          );
          const form = yield* browser.use("The connection dialog opens", (page) => {
            const dialog = page.getByRole("dialog", { name: `Connect ${name}`, exact: true });
            return dialog.waitFor({ state: "visible" }).then(() => dialog);
          });
          // A field's hint is part of its label, so read the inputs in declaration order.
          const types = yield* browser.use("Read each field's input type", () =>
            form
              .locator("input")
              .evaluateAll((inputs) => inputs.map((input) => input.getAttribute("type"))),
          );
          // A plain field is not secret, so it is shown; secret fields stay masked.
          expect(types).toEqual(["text", "password", "password"]);
          const { explained, destination, access } = yield* browser.use(
            "Read what the app gets",
            () =>
              Promise.all([
                form
                  .locator("[data-credential-access]")
                  .evaluateAll((lines) =>
                    lines.map((line) => line.getAttribute("data-credential-access")),
                  ),
                form.locator("[data-credential-hosts]").textContent(),
                form
                  .locator("[data-field-access]")
                  .evaluateAll((marks) =>
                    marks.map((mark) => mark.getAttribute("data-field-access")),
                  ),
              ]).then(([explained, destination, access]) => ({ explained, destination, access })),
          );
          if (host === null) {
            // Without hosts the app reads every secret: only that explainer shows, asking for hosts.
            expect(explained).toEqual(["readable"]);
            expect(destination).toContain("ask your agent to use stubbed secrets");
            expect(access).toEqual(["readable", "readable"]);
          } else {
            // Each tag the form shows is explained once: the hidden token and the raw field.
            expect(explained).toEqual(["hidden", "readable"]);
            expect(destination).toContain("The app and your agent only get a placeholder");
            expect(destination).toContain(`real value on requests to ${host}.`);
            expect(access).toEqual(["hidden", "readable"]);
            const tooltip = yield* browser.use("Hover the hidden field's mark", (page) =>
              form
                .getByRole("img", { name: "Hidden from app" })
                .hover()
                .then(() => page.getByRole("tooltip").textContent()),
            );
            expect(tooltip).toContain(`real value on requests to ${host}`);
          }
          yield* browser.use("Close the dialog", (page) => page.keyboard.press("Escape"));
        }
      }),
    ),
  );

  it.effect(scenarios.credentialHostsGranted.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, connect, select, call } = yield* scenario;
        const upstream = yield* credentialUpstream;
        const name = `Credential grant ${randomUUID().slice(0, 8)}`;
        const declared = `127.0.0.1:${upstream.port}`;
        const original = yield* deploy(name, credentialApp({ name, host: declared, health: null }));
        const values = synthetic();
        const { account } = yield* connect(original.path, name, values);
        // The same provider declared with more hosts, and with none.
        const others = [
          yield* deploy(
            `${name} wider`,
            credentialApp({ name, host: [declared, `localhost:${upstream.port}`], health: null }),
          ),
          yield* deploy(`${name} undeclared`, credentialApp({ name, host: null, health: null })),
        ];
        const provider = (deployed: (typeof others)[number]) =>
          deployed.app.requirements.accounts.service!.provider;
        // Hosts are not part of the provider's identity, so the account fills every slot.
        expect(others.map(provider)).toEqual([provider(original), provider(original)]);
        for (const other of others) {
          const profile = yield* select(other.path, account);
          // Connected for one host, the account is sealed even where the app declares none.
          const fields = yield* call(other.path, Fields, "fields", {}, profile);
          expect(fields.token).toMatch(handle);
          const widened = yield* call(
            other.path,
            Sent,
            "send",
            { url: `${upstream.undeclaredOrigin}/widened` },
            profile,
          );
          expect(widened.status).toBe(421);
          const granted = yield* call(
            other.path,
            Sent,
            "send",
            { url: `${upstream.origin}/granted` },
            profile,
          );
          expect(granted.status).toBe(200);
        }
        const received = yield* upstream.received;
        expect(received.filter((entry) => entry.url.includes("/widened"))).toEqual([]);
        expect(
          received
            .filter((entry) => entry.url.includes("/granted"))
            .map((entry) => entry.authorization),
        ).toEqual([`Bearer ${values.token}`, `Bearer ${values.token}`]);
      }),
    ),
  );

  it.effect(scenarios.credentialHostsProduct.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, deploy, connect, call, apiKey } = yield* scenario;
        const origin = (yield* Target).metadata.origin;
        const name = `Credential product ${randomUUID().slice(0, 8)}`;
        const { path } = yield* deploy(
          name,
          credentialApp({ name, host: new URL(origin).host, health: null }),
        );
        const key = yield* apiKey;
        const { profile } = yield* connect(path, name, {
          region: "synthetic-region",
          token: key,
          signing: `synthetic-signing-${randomUUID()}`,
        });
        const fields = yield* call(path, Fields, "fields", {}, profile);
        expect(fields.token).toMatch(handle);
        // The product accepts only the real key, so a success proves Executor substituted it on
        // the app's outbound request; the handle itself would be refused.
        const inventory = yield* call(
          path,
          Sent,
          "send",
          { url: `${origin}/api/organizations/${actors.organization.id}/inventory` },
          profile,
        );
        expect(inventory.status, inventory.text).toBe(200);
        expect(inventory.text).not.toContain(key);
      }),
    ),
  );

  it.effect(scenarios.credentialHostsSubstituted.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, check, connect, call } = yield* scenario;
        const upstream = yield* credentialUpstream;
        const name = `Credential hosts ${randomUUID().slice(0, 8)}`;
        const { path, app } = yield* deploy(
          name,
          credentialApp({ name, host: `127.0.0.1:${upstream.port}`, health: upstream.origin }),
        );
        const values = synthetic();
        // The account check runs before the account is saved, through the same network.
        const checked = yield* check(path, app.requirements.accounts.service!.provider, values);
        expect(checked.status).toBe("healthy");
        const { profile } = yield* connect(path, name, values);
        const { token } = yield* call(path, Fields, "fields", {}, profile);
        expect(token).toMatch(handle);

        const replies = yield* call(
          path,
          Schema.Array(Sent),
          "placements",
          { origin: upstream.origin },
          profile,
        );
        expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200, 200]);
        const received = yield* upstream.received;
        const at = (pathname: string): ReceivedRequest => {
          const found = received.find(
            (entry) => new URL(entry.url, upstream.origin).pathname === pathname,
          );
          if (found === undefined) return expect.fail(`The service never received ${pathname}`);
          return found;
        };

        expect(at("/health").authorization).toBe(`Bearer ${values.token}`);
        // Each placement reached the service with the real value.
        const query = at("/query");
        expect(query.authorization).toBe(`Bearer ${values.token}`);
        expect(query.apiKey).toBe(values.token);
        expect(new URL(query.url, upstream.origin).searchParams.get("key")).toBe(values.token);
        expect(JSON.parse(at("/json").body)).toEqual({ token: values.token });
        expect(new URLSearchParams(at("/form").body).get("token")).toBe(values.token);
        expect(
          Buffer.from(
            at("/basic").authorization?.replace(/^Basic /, "") ?? "",
            "base64",
          ).toString(),
        ).toBe(`user:${values.token}`);

        // The service echoed the value in headers and bodies; app code read the handle instead.
        for (const reply of replies.slice(0, 3)) expect(reply.text).not.toContain(values.token);
        // Every invocation seals afresh, so the echo carries this call's handle, not the one above.
        const echoed = /^Bearer (exsec_[0-9a-f]+_)$/;
        expect(replies[0]!.echoed).toMatch(echoed);
        expect(
          Schema.decodeUnknownSync(Schema.fromJsonString(ReceivedRequest))(replies[0]!.text),
        ).toMatchObject({ authorization: replies[0]!.echoed });
      }),
    ),
  );
});
