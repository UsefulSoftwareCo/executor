/** The paired local operator's scoped connection limits a real OAuth client and revokes it. */
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { deployLocalMcpApp } from "../support/mcp-app.ts";
import { pairLocalOperator } from "../support/mcp-consent.ts";
import {
  ConnectionView,
  Execution,
  clientGrantId,
  consentTo,
  readWriteAppFiles,
  revokeClientGrants,
} from "../support/mcp-connections.ts";
import { Target } from "../support/platform.ts";
import { connectLocalAccount } from "../support/app-accounts.ts";
import { linkLocal, localLinks } from "../support/local-links.ts";
import { appsManifest } from "../support/apps-release.ts";
import { siteless } from "../support/failure-site.ts";

/**
 * MCP clients print a refused request's body after their own prefix, such as "Error POSTing to
 * endpoint:", so the JSON-RPC error names the grant's own reason for the refusal.
 */
const refusal = (message: string) => ({
  jsonrpc: "2.0",
  id: null,
  error: {
    // JSON-RPC Invalid Request, as for the MCP transport's own rejections.
    code: -32600,
    message: `GrantForbidden (HTTP 403): ${message} Retryable (unchanged call): no.`,
    data: { code: "GrantForbidden", status: 403 },
  },
});
const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const SearchPage = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String })),
  remaining: Schema.Number,
  next: Schema.Unknown,
});
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});
/** A resumed call that failed, with the refusal's one-line summary. */
const Refused = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      message: Schema.String,
      response: Schema.Struct({ code: Schema.String, status: Schema.Number }),
    }),
  }),
});
/** An app with one keyed account whose `review` waits for the client to approve it. */
const reviewAppFiles = (provider: string) => [
  {
    path: "index.ts",
    content: `
import { defineApp, defineProvider, mutation, object, router, secrets, string } from "apps";
import { always } from "apps/operations/approval";
const service = defineProvider({ name: ${JSON.stringify(provider)}, auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service } } }, async () => ({
  tools: router({
    review: mutation({ description: "Review after approval", input: object({}), approval: always() }, async () => ({ reviewed: true })),
  }),
}));
`,
  },
  appsManifest,
];
/** An account-free app whose `review` waits for the client to approve it. */
const accountFreeReviewAppFiles = [
  {
    path: "index.ts",
    content: `
import { defineApp, mutation, object, router } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, async () => ({
  tools: router({
    review: mutation({ description: "Review after approval", input: object({}), approval: always() }, async () => ({ reviewed: true })),
  }),
}));
`,
  },
  appsManifest,
];

layer(TestLive, { excludeTestServices: true })("Local scoped MCP connections", (it) => {
  it.effect(scenarios.localScopedConnections.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          evidence = yield* Evidence,
          mcp = yield* McpClient;
        const operator = yield* pairLocalOperator;
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const receipt = randomUUID();
        const deployed = yield* operator.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Scoped app ${receipt.slice(0, 8)}`,
            files: readWriteAppFiles(receipt),
          },
          headers,
        );
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Schema.Struct({ app: App }), deployed);
        yield* Effect.addFinalizer(() =>
          operator.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const hidden = yield* deployLocalMcpApp;
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const created = yield* api.request(operator, "POST", "/dashboard/api/mcp/connections", {
          id: randomUUID(),
          name: "Read only",
          apps: [{ app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } }],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const connection = yield* body(ConnectionView, created);
        expect(connection.url).toBe(`${target.metadata.origin}/mcp?connection=${connection.id}`);
        const consent = yield* evidence.step(
          "Authorize the connection's URL as the paired operator",
          consentTo(operator, connection.url),
        );
        clients.push(consent.clientId);
        expect(consent.status).toBe(200);
        const token = yield* consent.tokens;
        const client = yield* mcp.connect(token, "local-scoped", {
          connection: connection.id,
        });
        const run = (operation: string, code: string) =>
          client
            .use(operation, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Execution)(result.structuredContent),
              ),
            );
        const appPath = `tools[${JSON.stringify(app.slug)}]`;
        const [read, write, excluded] = yield* Effect.all(
          [
            run("Call the read tool", `return await ${appPath}.read({})`),
            run("Call the write tool", `return await ${appPath}.write({message: "x"})`),
            run(
              "Call an excluded app",
              `return await tools[${JSON.stringify(hidden.app.slug)}].echo({message: "x"})`,
            ),
          ],
          { concurrency: 3 },
        );
        expect(read.execution).toEqual({ ok: true, value: { read: receipt } });
        expect(write.execution.ok).toBe(false);
        expect(excluded.execution.ok).toBe(false);
        // The administrative key keeps full access on the plain URL but cannot enter a connection.
        const adminMoved = yield* Effect.exit(
          mcp.connect(Redacted.make(Redacted.value(target.apiKey)), "admin-connection", {
            connection: connection.id,
          }),
        );
        expect(Exit.isFailure(adminMoved)).toBe(true);
        yield* evidence.step(
          "A credential used at another MCP URL names the URL it works at",
          Effect.gen(function* () {
            const anonymous = yield* api.session();
            const admin = yield* api.request(
              anonymous,
              "POST",
              `/mcp?connection=${connection.id}`,
              listTools,
              headers,
            );
            expect(admin.status).toBe(403);
            expect(admin.body).toMatchObject(
              refusal(
                "This credential works only at the MCP URL ending in /mcp, not at the URL of this request. Recovery: Connect at the MCP URL ending in /mcp, or connect again at this URL to get a credential for it, then retry.",
              ),
            );
            const unscoped = yield* api.request(anonymous, "POST", "/mcp", listTools, {
              authorization: `Bearer ${Redacted.value(token)}`,
            });
            expect(unscoped.status).toBe(403);
            expect(unscoped.body).toMatchObject(
              refusal(
                `This credential works only at the MCP URL ending in /mcp?connection=${connection.id}, not at the URL of this request. Recovery: Connect at the MCP URL ending in /mcp?connection=${connection.id}, or connect again at this URL to get a credential for it, then retry.`,
              ),
            );
            // A malformed URL names no MCP address, so it is invalid rather than refused.
            const malformed = yield* api.request(
              anonymous,
              "POST",
              "/mcp?elicitation_mode=invalid",
              listTools,
              headers,
            );
            expect(malformed.status).toBe(400);
            expect(malformed.body).toEqual({
              error: "Unsupported elicitation_mode or connection.",
            });
          }),
        );
        yield* evidence.step(
          "Revoking the connection stops its client",
          Effect.gen(function* () {
            const revoked = yield* api.request(
              operator,
              "POST",
              `/dashboard/api/mcp/connections/${connection.id}/revoke`,
            );
            expect(revoked.status).toBe(200);
            const after = yield* Effect.exit(
              run("Call after revocation", `return await ${appPath}.read({})`),
            );
            expect(Exit.isFailure(after)).toBe(true);
            const listed = yield* body(
              Schema.Array(ConnectionView),
              yield* api.request(operator, "GET", "/dashboard/api/mcp/connections"),
            );
            expect(listed).toEqual([]);
          }),
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.localScopedSearch.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          evidence = yield* Evidence,
          mcp = yield* McpClient;
        const operator = yield* pairLocalOperator;
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const receipt = randomUUID();
        const deployed = yield* operator.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Scoped search ${receipt.slice(0, 8)}`,
            files: readWriteAppFiles(receipt),
          },
          headers,
        );
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Schema.Struct({ app: App }), deployed);
        yield* Effect.addFinalizer(() =>
          operator.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const appPath = `tools[${JSON.stringify(app.slug)}]`;
        const search =
          (client: Effect.Success<ReturnType<typeof mcp.connect>>) =>
          (operation: string, input: object) =>
            client
              .use(operation, (client, signal) =>
                client.callTool(
                  {
                    name: "execute",
                    arguments: { code: `return await tools.search(${JSON.stringify(input)});` },
                  },
                  undefined,
                  { signal },
                ),
              )
              .pipe(
                Effect.flatMap((result) =>
                  Schema.decodeUnknownEffect(Execution)(result.structuredContent),
                ),
                Effect.flatMap(({ execution }) =>
                  Schema.decodeUnknownEffect(SearchPage)(execution.value),
                ),
              );
        // Every tool of the app matches its name, so a page of one would count the other.
        const full = search(
          yield* mcp.connect(Redacted.make(Redacted.value(target.apiKey)), "local-full"),
        );
        const unrestricted = yield* evidence.step(
          "Full access finds both of the app's tools",
          full("Search the app with full access", {
            query: app.name,
            namespace: app.slug,
            limit: 1,
          }),
        );
        expect(unrestricted.items).toHaveLength(1);
        expect(unrestricted.remaining).toBe(1);
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const created = yield* api.request(operator, "POST", "/dashboard/api/mcp/connections", {
          id: randomUUID(),
          name: "Read by name",
          apps: [
            {
              app: app.id,
              runsAs: [{ kind: "app" }],
              tools: { kind: "selected", names: ["read"] },
            },
          ],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const connection = yield* body(ConnectionView, created);
        const consent = yield* evidence.step(
          "Authorize a connection that names only the read tool",
          consentTo(operator, connection.url),
        );
        clients.push(consent.clientId);
        expect(consent.status).toBe(200);
        const scoped = search(
          yield* mcp.connect(yield* consent.tokens, "local-scoped-search", {
            connection: connection.id,
          }),
        );
        yield* evidence.step(
          "Search, listing and exact paths never reach the tool the connection leaves out",
          Effect.gen(function* () {
            const ranked = yield* scoped("Search the app by name", { query: app.name, limit: 1 });
            expect(ranked.items.map((item) => item.path)).toEqual([`${appPath}.read`]);
            expect(ranked.remaining).toBe(0);
            expect(ranked.next).toBeNull();
            const listed = yield* scoped("List the app's tools", { namespace: app.slug });
            expect(listed.items.map((item) => item.path)).toEqual([`${appPath}.read`]);
            expect(listed.remaining).toBe(0);
            const exact = yield* scoped("Search for the left-out tool's exact path", {
              query: `${appPath}.write`,
            });
            expect(exact.items.map((item) => item.path)).not.toContain(`${appPath}.write`);
          }),
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.localScopedLazyReach.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          evidence = yield* Evidence,
          mcp = yield* McpClient;
        const operator = yield* pairLocalOperator;
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const run = randomUUID().slice(0, 8);
        const deploy = (name: string) =>
          Effect.gen(function* () {
            const deployed = yield* operator.send(
              "POST",
              "/v1/apps/deploy",
              { owner: "local", name: `${name} ${run}`, files: readWriteAppFiles(randomUUID()) },
              headers,
            );
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const { app } = yield* body(Schema.Struct({ app: App }), deployed);
            yield* Effect.addFinalizer(() =>
              operator.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
            );
            return app;
          });
        const app = yield* deploy("Lazy reach named");
        const other = yield* deploy("Lazy reach left out");
        const appPath = `tools[${JSON.stringify(app.slug)}]`;
        const otherPath = `tools[${JSON.stringify(other.slug)}]`;
        const Ran = Schema.Struct({
          status: Schema.Literal("completed"),
          execution: Schema.Struct({
            ok: Schema.Boolean,
            value: Schema.optional(Schema.Unknown),
            error: Schema.optional(Schema.Struct({ kind: Schema.String, message: Schema.String })),
          }),
        });
        const runner =
          (client: Effect.Success<ReturnType<typeof mcp.connect>>) =>
          (operation: string, code: string) =>
            client
              .use(operation, (client, signal) =>
                client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
              )
              .pipe(
                Effect.flatMap((result) =>
                  Schema.decodeUnknownEffect(Ran)(result.structuredContent),
                ),
                Effect.map(({ execution }) => execution),
              );
        const paths = (value: unknown) =>
          Schema.decodeUnknownEffect(SearchPage)(value).pipe(
            Effect.map(({ items }) => items.map((item) => item.path)),
          );
        // Computed names, so neither app is named statically.
        const computed = (slug: string) => `[${JSON.stringify(slug)}][0]`;

        // With full access, the dynamic path reaches the write tool.
        const full = runner(
          yield* mcp.connect(Redacted.make(Redacted.value(target.apiKey)), "local-lazy-full"),
        );
        expect(
          yield* full(
            "Write through a computed name with full access",
            `return await tools[${computed(app.slug)}].write({ message: "full" });`,
          ),
        ).toMatchObject({ ok: true, value: { wrote: "full" } });

        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const created = yield* api.request(operator, "POST", "/dashboard/api/mcp/connections", {
          id: randomUUID(),
          name: "Read one app by name",
          apps: [
            {
              app: app.id,
              runsAs: [{ kind: "app" }],
              tools: { kind: "selected", names: ["read"] },
            },
          ],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const connection = yield* body(ConnectionView, created);
        const consent = yield* evidence.step(
          "Authorize a connection that names only one app's read tool",
          consentTo(operator, connection.url),
        );
        clients.push(consent.clientId);
        expect(consent.status).toBe(200);
        const scoped = runner(
          yield* mcp.connect(yield* consent.tokens, "local-lazy-scoped", {
            connection: connection.id,
          }),
        );

        yield* evidence.step(
          "CodeMode's search() finds only the tool the connection names",
          Effect.gen(function* () {
            const named = yield* scoped(
              "Search the named app",
              `return await search({ query: ${JSON.stringify(app.name)} });`,
            );
            expect(yield* paths(named.value)).toEqual([`${appPath}.read`]);
            const exact = yield* scoped(
              "Search for the left-out tool's exact path",
              `return await search({ query: ${JSON.stringify(`${appPath}.write`)} });`,
            );
            expect(yield* paths(exact.value)).not.toContain(`${appPath}.write`);
            const left = yield* scoped(
              "Search the left-out app",
              `return await search({ query: ${JSON.stringify(other.name)} });`,
            );
            for (const path of yield* paths(left.value)) expect(path).not.toContain(otherPath);
          }),
        );

        yield* evidence.step(
          "Dynamic access reaches exactly what static access reaches",
          Effect.gen(function* () {
            const keys = yield* scoped(
              "List the named app's tools",
              `return Object.keys(tools[${computed(app.slug)}]);`,
            );
            expect(keys).toMatchObject({ ok: true, value: ["read"] });
            for (const [label, slug, tool] of [
              ["left-out tool", app.slug, "write"],
              ["left-out app", other.slug, "read"],
            ] as const) {
              const input = tool === "write" ? `{ message: "scoped" }` : `{}`;
              const direct = yield* scoped(
                `Call the ${label} statically`,
                `return await tools[${JSON.stringify(slug)}].${tool}(${input});`,
              );
              const dynamic = yield* scoped(
                `Call the ${label} through a computed name`,
                `return await tools[${computed(slug)}].${tool}(${input});`,
              );
              expect(direct.ok, label).toBe(false);
              expect(dynamic, label).toEqual(direct);
            }
          }),
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.localMcpOAuthWithoutResource.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          evidence = yield* Evidence,
          mcp = yield* McpClient;
        const operator = yield* pairLocalOperator;
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const consent = yield* evidence.step(
          "Authorize a client that sends no resource parameter",
          consentTo(operator, undefined),
        );
        clients.push(consent.clientId);
        // The consent page names the plain MCP URL the grant is bound to.
        expect(consent.consentResources).toEqual([`${target.metadata.origin}/mcp`]);
        expect(consent.status).toBe(200);
        const token = yield* consent.tokens;
        const client = yield* mcp.connect(token, "local-without-resource");
        const listed = yield* client.use("The plain MCP URL accepts the grant", (client) =>
          client.listTools(),
        );
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
          "call",
          "describe",
          "execute",
          "resume",
          "search",
          "skills",
        ]);
        // The default is the plain URL's model mode only, not every approval mode.
        const other = yield* Effect.exit(
          mcp.connect(token, "local-without-resource-browser-mode", { mode: "browser" }),
        );
        expect(Exit.isFailure(other)).toBe(true);
        const anonymous = yield* api.session();
        const bearer = { authorization: `Bearer ${Redacted.value(token)}` };
        const browserMode = yield* api.request(
          anonymous,
          "POST",
          "/mcp?elicitation_mode=browser",
          listTools,
          bearer,
        );
        expect(browserMode.status).toBe(403);
        expect(browserMode.body).toMatchObject(
          refusal(
            "This credential works only at the MCP URL ending in /mcp, not at the URL of this request. Recovery: Connect at the MCP URL ending in /mcp, or connect again at this URL to get a credential for it, then retry.",
          ),
        );
        yield* evidence.step(
          "A grant issued at the model-mode URL cannot be narrowed to browser approval",
          Effect.gen(function* () {
            // No URL could serve it: its own URL cannot ask for browser approval.
            const narrowed = yield* api.request(operator, "POST", "/api/auth/mcp/grants/narrow", {
              id: yield* clientGrantId(operator, consent.clientId),
              policy: { kind: "tools", apps: [], approval: "browser" },
            });
            expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(403);
            expect(narrowed.body).toMatchObject({
              message:
                "Browser approval needs a grant issued at an MCP URL with elicitation_mode=browser.",
            });
            const relisted = yield* client.use("The grant still serves its own URL", (client) =>
              client.listTools(),
            );
            expect(relisted.tools.map((tool) => tool.name).sort()).toEqual([
              "call",
              "describe",
              "execute",
              "resume",
              "search",
              "skills",
            ]);
          }),
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.localMcpGrantRefusals.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          evidence = yield* Evidence,
          mcp = yield* McpClient;
        const operator = yield* pairLocalOperator;
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        // Connection links are issued to agents: a request with a browser origin is refused.
        const agent: Session = {
          ...operator,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return operator.send(method, path, data, { ...rest, ...headers });
          },
        };
        const name = `Refused app ${randomUUID().slice(0, 8)}`;
        const deployed = yield* operator.send(
          "POST",
          "/v1/apps/deploy",
          { owner: "local", name, files: reviewAppFiles(name) },
          headers,
        );
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Schema.Struct({ app: App }), deployed);
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* operator.send("DELETE", `/v1/apps/${app.id}`, undefined, headers);
            for (const account of accounts)
              yield* operator.send("DELETE", `/v1/accounts/${account}`, undefined, headers);
          }).pipe(Effect.orDie),
        );
        // Connecting from the app links the account, replacing the one linked before; both stay
        // saved. Calls use the linked account.
        const connect = (token: string) =>
          Effect.gen(function* () {
            const { id: account } = yield* connectLocalAccount(agent, {
              app: app.id,
              requirement: "service",
              method: "key",
              label: token,
              fields: { token },
            });
            accounts.push(account);
            return account;
          });
        const other = yield* connect("synthetic-other");
        const used = yield* connect("synthetic-used");
        expect(yield* localLinks(agent, app.id)).toEqual([used]);
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const created = yield* api.request(operator, "POST", "/dashboard/api/mcp/connections", {
          id: randomUUID(),
          name: "Narrowed",
          apps: [{ app: app.id, runsAs: [{ kind: "account", id: used }], tools: { kind: "all" } }],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const connection = yield* body(ConnectionView, created);
        yield* Effect.addFinalizer(() =>
          api
            .request(operator, "POST", `/dashboard/api/mcp/connections/${connection.id}/revoke`)
            .pipe(Effect.orDie),
        );
        const save = (apps: unknown) =>
          api.request(operator, "PUT", `/dashboard/api/mcp/connections/${connection.id}`, {
            name: "Narrowed",
            apps,
          });
        const consent = yield* consentTo(operator, connection.url);
        clients.push(consent.clientId);
        expect(consent.status).toBe(200);
        const client = yield* mcp.connect(yield* consent.tokens, "local-refusals", {
          connection: connection.id,
        });
        const review = client
          .use("Start a review that waits for approval", (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(app.slug)}].review({})`,
                },
              },
              undefined,
              { signal },
            ),
          )
          .pipe(
            Effect.flatMap((result) =>
              Schema.decodeUnknownEffect(Pending)(result.structuredContent),
            ),
          );
        const pending = yield* Effect.all([review, review, review], { concurrency: 3 });
        // Each approval is answered after the connection stops including part of the call.
        const refusedAfter = (requestId: string, apps: unknown) =>
          Effect.gen(function* () {
            const saved = yield* save(apps);
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            const resumed = yield* client.use("Approve the review", (client, signal) =>
              client.callTool(
                { name: "resume", arguments: { requestId, response: { action: "accept" } } },
                undefined,
                { signal },
              ),
            );
            const refused = yield* Schema.decodeUnknownEffect(Refused)(resumed.structuredContent);
            expect(refused.execution.error.response).toEqual({
              code: "GrantForbidden",
              status: 403,
            });
            return siteless(refused.execution.error.message);
          });
        yield* evidence.step(
          "A read-only connection names the tool it excludes",
          Effect.gen(function* () {
            expect(
              yield* refusedAfter(pending[0].requestId, [
                {
                  app: app.id,
                  runsAs: [{ kind: "account", id: used }],
                  tools: { kind: "readOnly" },
                },
              ]),
            ).toBe(
              `GrantForbidden (HTTP 403): This credential’s grant does not include the tool “review” of the app ${app.id}. Recovery: Use a tool the grant includes, or add this tool to its connection or grant, then retry. Retryable (unchanged call): no.`,
            );
          }),
        );
        yield* evidence.step(
          "A connection that runs the app only with another account names the account it excludes",
          Effect.gen(function* () {
            // A connection names only accounts linked to the app. Linking the other account
            // replaces the one the waiting call started with.
            yield* linkLocal(agent, app.id, "service", other);
            expect(
              yield* refusedAfter(pending[1].requestId, [
                {
                  app: app.id,
                  runsAs: [{ kind: "account", id: other }],
                  tools: { kind: "all" },
                },
              ]),
            ).toBe(
              `GrantForbidden (HTTP 403): This credential’s grant includes the app ${app.id}, but not running it with the account ${used}. Recovery: Run the app with accounts the grant allows, or add this target to its connection, then retry. Retryable (unchanged call): no.`,
            );
          }),
        );
        yield* evidence.step(
          "A connection without the app names the app it excludes",
          Effect.gen(function* () {
            expect(yield* refusedAfter(pending[2].requestId, [])).toBe(
              `GrantForbidden (HTTP 403): This credential’s grant does not include the app ${app.id}. Recovery: Use an app the grant includes, or add this app to its connection or grant, then retry. Retryable (unchanged call): no.`,
            );
          }),
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.localMcpResumeAcrossSessions.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          mcp = yield* McpClient;
        const operator = yield* pairLocalOperator;
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const deployed = yield* operator.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Resumed app ${randomUUID().slice(0, 8)}`,
            files: accountFreeReviewAppFiles,
          },
          headers,
        );
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Schema.Struct({ app: App }), deployed);
        yield* Effect.addFinalizer(() =>
          operator.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const grant = Effect.gen(function* () {
          const consent = yield* consentTo(operator, undefined);
          clients.push(consent.clientId);
          expect(consent.status).toBe(200);
          return yield* consent.tokens;
        });
        const [owner, other] = yield* Effect.all([grant, grant]);
        const paused = yield* (yield* mcp.connect(owner, "local-resume-first")).use(
          "Pause an approval-gated tool in the first MCP session",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: { code: `return await tools[${JSON.stringify(app.slug)}].review({})` },
              },
              undefined,
              { signal },
            ),
        );
        const pending = yield* Schema.decodeUnknownEffect(Pending)(paused.structuredContent);
        // Some clients open a new MCP session for every tool call, so each resume below uses one.
        const resume = (label: string, token: typeof owner, name: string) =>
          Effect.gen(function* () {
            const session = yield* mcp.connect(token, name);
            const result = yield* session.use(label, (client, signal) =>
              client.callTool(
                {
                  name: "resume",
                  arguments: { requestId: pending.requestId, response: { action: "accept" } },
                },
                undefined,
                { signal },
              ),
            );
            return result.structuredContent;
          });
        const Status = Schema.Struct({ status: Schema.String });
        const status = (content: unknown) =>
          Schema.decodeUnknownEffect(Status)(content).pipe(Effect.map(({ status }) => status));
        expect(
          yield* status(yield* resume("Another grant cannot resume", other, "local-resume-other")),
        ).toBe("unavailable");
        expect(
          yield* status(
            yield* resume(
              "The administrative key cannot resume a grant's program",
              Redacted.make(Redacted.value(target.apiKey)),
              "local-resume-admin",
            ),
          ),
        ).toBe("unavailable");
        const resumed = yield* resume(
          "The same grant resumes from a new MCP session",
          owner,
          "local-resume-next",
        );
        expect(yield* status(resumed)).toBe("completed");
        expect((yield* Schema.decodeUnknownEffect(Execution)(resumed)).execution).toEqual({
          ok: true,
          value: { reviewed: true },
        });
        expect(
          yield* status(
            yield* resume(
              "A replayed resume from yet another session is unavailable",
              owner,
              "local-resume-replay",
            ),
          ),
        ).toBe("unavailable");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
