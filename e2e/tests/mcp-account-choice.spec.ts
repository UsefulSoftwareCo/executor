/**
 * MCP calls never choose accounts. A plain requirement uses the one account linked to the app:
 * connecting another replaces it. A tool call that names accounts under `$accounts` fails with
 * `AccountChoiceUnsupported` before the tool runs, caught or not, and the skills tool refuses an
 * `accounts` input the same way.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { connectLocalAccount, connectionsPath, linkedAccountIds } from "../support/app-accounts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { localAgent, localLinks } from "../support/local-links.ts";
import { McpClient } from "../support/mcp-client.ts";

const source = `import { defineApp, defineProvider, secrets, object, string, query, mutation, router, type QueryContext, type MutationContext } from "apps";
const service = defineProvider({ name: "Account choice fixture", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
const requirements = { user: { accounts: { service } } };
export default defineApp(requirements, async (ctx) => ({
  tools: router({
    who: query({ input: object({}), description: "Report the account this call runs with" }, async () => ctx.user.accounts.service.id),
    tick: mutation({ input: object({}), description: "Record one run" }, async (call: MutationContext<typeof requirements>) => {
      call.sql.exec("INSERT INTO ticks (account) VALUES (?)", call.user.accounts.service.id);
      return call.user.accounts.service.id;
    }),
    ticks: query({ input: object({}), description: "List recorded runs" }, async (call: QueryContext<typeof requirements>) =>
      call.sql.exec<{ account: string }>("SELECT account FROM ticks ORDER BY seq").toArray().map((row) => row.account)),
  }),
  skills: [{ name: "linked-account", description: "Instructions for the linked account", files: [{ path: "SKILL.md",
    content: "---\\nname: linked-account\\ndescription: Instructions for the linked account\\n---\\n" + ctx.user.accounts.service.id }] }],
}));`;
const migration = {
  path: "migrations/0001_ticks.sql",
  content: "CREATE TABLE ticks (seq INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL);\n",
};
const files = [{ path: "index.ts", content: source }, migration, appsManifest];

/** AccountChoiceUnsupported's description, which every refusal carries. */
const unsupported =
  "Accounts are not chosen per call. Each app uses the accounts you linked to it: one for each plain requirement, and every linked account for a many() requirement.";

const Execution = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
    Schema.Struct({
      ok: Schema.Literal(false),
      error: Schema.Struct({
        kind: Schema.String,
        message: Schema.String,
        response: Schema.optional(Schema.Struct({ code: Schema.String, status: Schema.Number })),
      }),
    }),
  ]),
});
const Search = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String, input: Schema.String })),
  namespaces: Schema.Array(
    Schema.Struct({ path: Schema.String, accounts: Schema.optional(Schema.String) }),
  ),
});
/** A caught tool error's message: the error's JSON response. */
const CaughtResponse = Schema.fromJsonString(
  Schema.Struct({ code: Schema.String, status: Schema.Number, message: Schema.String }),
);
type Connected = Effect.Success<ReturnType<Effect.Success<typeof McpClient>["connect"]>>;
type Account = { readonly id: string; readonly label: string };

/**
 * The same MCP journey on every product, once `replaced` was connected first and `linked`
 * replaced it as the app's only linked account.
 */
const checkNoAccountChoice = (
  client: Connected,
  slug: string,
  replaced: Account,
  linked: Account,
) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const execute = (label: string, file: string, code: string) =>
      Effect.gen(function* () {
        const result = yield* client.use(label, (client, signal) =>
          client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
        );
        yield* evidence.json(file, result.structuredContent);
        return (yield* Schema.decodeUnknownEffect(Execution)(result.structuredContent)).execution;
      });
    const app = `tools[${JSON.stringify(slug)}]`;
    const choice = `{ $accounts: { service: ${JSON.stringify(replaced.id)} } }`;

    // The call runs with the linked account; the replaced one is never used.
    expect(
      yield* execute("Call with the linked account", "linked.json", `return await ${app}.who({});`),
    ).toEqual({ ok: true, value: linked.id });
    // Search lists the account calls use and offers no way to choose another.
    const searched = yield* execute(
      "Search the app's tools",
      "search.json",
      `return await tools.search({ query: "Report the account this call runs with", limit: 5 });`,
    );
    if (!searched.ok) return yield* Effect.die(new Error(searched.error.message));
    const listing = yield* Schema.decodeUnknownEffect(Search)(searched.value);
    expect(listing.items.find((item) => item.path === `${app}.who`)?.input).toBe("{}");
    expect(listing.namespaces.find((space) => space.path === app)?.accounts).toBe(
      `service: ${linked.id} (${linked.label})`,
    );

    // A caught refusal: the tool error's message is its JSON response.
    const caught = yield* execute(
      "Catch a call that names an account",
      "caught.json",
      `try { await ${app}.tick(${choice}); return { ran: true }; } catch (error) { return { message: error.message }; }`,
    );
    if (!caught.ok) return yield* Effect.die(new Error(caught.error.message));
    const { message } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ message: Schema.String }),
    )(caught.value);
    const response = yield* Schema.decodeUnknownEffect(CaughtResponse)(message);
    expect(response).toMatchObject({ code: "AccountChoiceUnsupported", status: 400 });
    expect(response.message).toContain(unsupported);
    // An uncaught refusal fails the execution with the same error.
    const uncaught = yield* execute(
      "Call naming an account without catching",
      "uncaught.json",
      `return await ${app}.tick(${choice});`,
    );
    if (uncaught.ok) return yield* Effect.die(new Error("A call naming an account ran"));
    expect(
      uncaught.error.message.startsWith(
        "AccountChoiceUnsupported (HTTP 400): Accounts are not chosen per call.",
      ),
      uncaught.error.message,
    ).toBe(true);
    // Neither refused call ran the tool; a call without a choice does, with the linked account.
    expect(
      yield* execute("No refused call ran", "before.json", `return await ${app}.ticks({});`),
    ).toEqual({ ok: true, value: [] });
    expect(
      yield* execute(
        "Run the mutation without a choice",
        "ran.json",
        `await ${app}.tick({}); return await ${app}.ticks({});`,
      ),
    ).toEqual({ ok: true, value: [linked.id] });

    // The skills tool reads with the linked account and refuses an `accounts` input.
    const skills = (step: string, input: Record<string, unknown>) =>
      client.use(step, (client, signal) =>
        client.callTool({ name: "skills", arguments: input }, undefined, { signal }),
      );
    const read = yield* skills("Read the app's skill", { app: slug, name: "linked-account" });
    expect(read.isError, JSON.stringify(read)).not.toBe(true);
    expect(read.structuredContent).toMatchObject({ content: expect.stringContaining(linked.id) });
    const refused = yield* skills("Read the app's skill naming an account", {
      app: slug,
      name: "linked-account",
      accounts: { service: replaced.id },
    });
    expect(refused.isError, JSON.stringify(refused)).toBe(true);
    // The skills tool's error text carries the code and status, as the uncaught refusal above.
    expect(refused.content).toEqual([
      {
        type: "text",
        text: `AccountChoiceUnsupported (HTTP 400): ${unsupported} Recovery: Call again without choosing accounts. Change the app's accounts in its Accounts tab. Retryable (unchanged call): no.`,
      },
    ]);
  });

layer(HostedLive, { excludeTestServices: true })("Hosted MCP account choice", (it) => {
  it.effect(scenarios.mcpAccountChoice.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Account choice ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        const created: string[] = [];
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Account choice",
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id });
            yield* api.request(actors.owner, "DELETE", path);
            for (const account of created)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        // Connecting from the app saves each account and links it for the owner, replacing the
        // account linked before for the plain requirement.
        const connect = (label: string) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* api.request(
                actors.owner,
                "POST",
                connectionsPath(path, "user", "service"),
                {},
              ),
            );
            const submitted = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/submit`,
              { method: "key", label, fields: { token: `synthetic-${randomUUID()}` } },
            );
            expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
            const account = yield* body(Resource, submitted);
            created.push(account.id);
            return { id: account.id, label };
          });
        const work = yield* connect("Work key");
        const personal = yield* connect("Personal key");
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([personal.id]);
        const client = yield* mcp.connect(key.key, "account-choice", {
          organization: actors.organization.id,
        });
        yield* checkNoAccountChoice(client, app.slug, work, personal);
        // The replaced account stays saved.
        const kept = yield* api.request(actors.owner, "GET", `${prefix}/accounts/${work.id}`);
        expect(kept.status, JSON.stringify(kept.body)).toBe(200);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});

layer(TestLive, { excludeTestServices: true })("Local MCP account choice", (it) => {
  it.effect(scenarios.localMcpAccountChoice.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { agent, target } = yield* localAgent;
        const mcp = yield* McpClient;
        const deployed = yield* agent.send("POST", "/v1/apps/deploy", {
          owner: "local",
          name: `Account choice ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(
          Schema.Struct({ app: Schema.Struct({ id: Schema.String, slug: Schema.String }) }),
          deployed,
        );
        const created: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* agent.send("DELETE", `/v1/apps/${app.id}`);
            for (const account of created) yield* agent.send("DELETE", `/v1/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        // Connecting from the app links each account, replacing the one linked before.
        const add = (label: string) =>
          Effect.gen(function* () {
            const account = yield* connectLocalAccount(agent, {
              app: app.id,
              requirement: "service",
              method: "key",
              label,
              fields: { token: `synthetic-${randomUUID()}` },
            });
            created.push(account.id);
            return { id: account.id, label };
          });
        const work = yield* add("Work key");
        const personal = yield* add("Personal key");
        expect(yield* localLinks(agent, app.id)).toEqual([personal.id]);
        const client = yield* mcp.connect(target.apiKey, "local-account-choice");
        yield* checkNoAccountChoice(client, app.slug, work, personal);
        // The replaced account stays saved.
        const kept = yield* agent.send("GET", `/v1/accounts/${work.id}`);
        expect(kept.status, JSON.stringify(kept.body)).toBe(200);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
