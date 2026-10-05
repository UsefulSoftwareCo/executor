/** Routers group tools by path, carry source metadata to agents, and isolate a failing source. */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Redacted, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { createProfile } from "../support/profiles.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { outputContractProblems } from "../support/output-contract.ts";
import { withApps } from "../support/apps-release.ts";

const Wire = Schema.Struct({
  id: Schema.optionalKey(Schema.Json),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});

const instructions = "Search the docs before answering. Cite the page you used.";

/** An MCP server that describes itself during initialization. One tool name contains a dot. */
const docsServer = Effect.gen(function* () {
  const routes = Layer.mergeAll(
    HttpRouter.add("GET", "/mcp", HttpServerResponse.empty({ status: 405 })),
    HttpRouter.add(
      "POST",
      "/mcp",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const message = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Wire)));
        if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
        const result = (value: Schema.Json) =>
          HttpServerResponse.json({ jsonrpc: "2.0", id: message.id ?? null, result: value });
        if (message.method === "initialize")
          return yield* result({
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: {
              name: "docs-fixture",
              title: "Docs fixture",
              description: "Searchable product documentation",
              version: "1",
            },
            instructions,
          });
        if (message.method === "tools/list")
          return yield* result({
            tools: ["lookup", "search.pages"].map((name) => ({
              name,
              description: `Synthetic ${name}`,
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
              // One tool declares the shape of its structured content; the other declares none.
              ...(name === "lookup"
                ? {
                    outputSchema: {
                      type: "object",
                      properties: { tool: { $ref: "#/$defs/Name" } },
                      required: ["tool"],
                      $defs: { Name: { type: "string" } },
                    },
                  }
                : {}),
              annotations: { readOnlyHint: true },
            })),
          });
        if (message.method === "tools/call") {
          const value = { tool: message.params?.name ?? null };
          return yield* result({
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
            isError: false,
          });
        }
        return yield* result({});
      }),
    ),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Expected TCP fixture");
  return `http://127.0.0.1:${server.address.port}`;
});

/** An inline OpenAPI document whose info and tag descriptions describe its router. */
const billing = (origin: string) => ({
  openapi: "3.1.0",
  info: { title: "Billing API", version: "1", description: "Invoices and refunds" },
  servers: [{ url: origin }],
  tags: [{ name: "invoices", description: "Issued invoices" }],
  paths: {
    "/invoices": {
      get: {
        operationId: "listInvoices",
        tags: ["invoices"],
        responses: { "200": { description: "Invoices" } },
      },
    },
  },
});

/** Static routers, an MCP server and an OpenAPI document under keys, and a server that is down. */
const source = (docs: string, offline: string) => `
import { defineApp, mutation, object, query, router, string } from "apps";
import { mcpRouter } from "apps/mcp";
import { liveOpenapiRouter } from "apps/openapi";
export default defineApp({ accounts: {} }, async ({ signal, cache, fetch }) => ({
  tools: router({
    health: query({ input: object({}) }, async () => "ok"),
    issues: router(
      {
        list: query({ input: object({}), description: "List open issues" }, async () => ["issue-1"]),
        close: mutation({ input: object({ id: string() }) }, async (_ctx, { id }) => ({ closed: id })),
      },
      { title: "Issues", description: "Issue triage", instructions: "Search before closing an issue." },
    ),
    // These two paths read alike once lowercased and dashed; their skills must not collide.
    issue: router({
      notes: router({ read: query({ input: object({}) }, async () => "nested") }, { instructions: "Nested notes." }),
    }),
    issue_notes: router({ read: query({ input: object({}) }, async () => "flat") }, { instructions: "Flat notes." }),
    docs: await mcpRouter({ url: ${JSON.stringify(docs)}, signal }),
    offline: router(await mcpRouter({ url: ${JSON.stringify(offline)}, signal }), {
      description: "A server that is down",
    }),
    api: liveOpenapiRouter({
      cache, fetch, signal,
      source: { document: ${JSON.stringify(billing(new URL(docs).origin))} },
      allowedOrigin: ${JSON.stringify(new URL(docs).origin)},
      securitySchemes: {}, methods: {}, oauth: [],
    }),
  }),
}));
`;

const Catalog = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      readOnly: Schema.optionalKey(Schema.Boolean),
      router: Schema.optionalKey(Schema.String),
      tags: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  routers: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      title: Schema.optionalKey(Schema.String),
      description: Schema.optionalKey(Schema.String),
      skill: Schema.optionalKey(Schema.String),
      tags: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      error: Schema.optionalKey(Schema.Struct({ _tag: Schema.String })),
    }),
  ),
});
const Skills = Schema.Struct({ skills: Schema.Array(Schema.Struct({ name: Schema.String })) });
const Failure = Schema.Struct({ _tag: Schema.String, mcp: Schema.optional(Schema.Unknown) });
/** An authored skill whose name a router's instructions would once have taken. */
const authoredSkill = (name: string) => ({
  path: `skills/${name}/SKILL.md`,
  content: `---\nname: ${name}\ndescription: Authored ${name} guide\n---\n\nAuthored ${name} guide.\n`,
});
const Document = Schema.Struct({ content: Schema.String });
const Executed = Schema.Struct({
  execution: Schema.Struct({ ok: Schema.Boolean, value: Schema.optional(Schema.Unknown) }),
  unavailableApps: Schema.Array(
    Schema.Struct({ app: Schema.String, router: Schema.optional(Schema.String) }),
  ),
});
const Search = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ path: Schema.String, description: Schema.String, signature: Schema.String }),
  ),
});

layer(HostedLive, { excludeTestServices: true })("App routers", (it) => {
  it.effect(scenarios.appRouters.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const mcp = yield* McpClient;
        const docs = yield* docsServer;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Routers ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "package.json",
              content: JSON.stringify({
                dependencies: withApps({
                  "@modelcontextprotocol/client": "2.0.0",
                  "@modelcontextprotocol/core": "2.0.0",
                }),
              }),
            },
            // Port 9 on loopback refuses connections, so the second server fails fast.
            { path: "index.ts", content: source(`${docs}/mcp`, "http://127.0.0.1:9/mcp") },
            authoredSkill("issues"),
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );

        // Paths come from router keys; kind stays on each tool. The failing server hides only
        // its own tools.
        const listed = yield* api.request(actors.owner, "GET", `${path}/tools`);
        expect(listed.status).toBe(200);
        const catalog = yield* body(Catalog, listed);
        expect(catalog.items.map((tool) => tool.name)).toEqual([
          "api.invoices.listInvoices",
          "docs.lookup",
          "docs.search.pages",
          "health",
          "issue.notes.read",
          "issue_notes.read",
          "issues.close",
          "issues.list",
        ]);
        const tool = (name: string) => catalog.items.find((item) => item.name === name);
        expect(tool("issues.close")).toMatchObject({ router: "issues", readOnly: false });
        expect(tool("issues.list")).toMatchObject({ router: "issues", readOnly: true });
        expect(tool("health")?.router).toBeUndefined();
        const router = (routerPath: string) =>
          catalog.routers.find((entry) => entry.path === routerPath);
        expect(router("issues")).toEqual({
          path: "issues",
          title: "Issues",
          description: "Issue triage",
          skill: "tools-issues",
        });
        // The MCP server's own self-description reaches the router.
        expect(router("docs")).toEqual({
          path: "docs",
          title: "Docs fixture",
          description: "Searchable product documentation",
          skill: "tools-docs",
        });
        expect(router("offline")?.description).toBe("A server that is down");
        // An OpenAPI document's info describes its router; its tags label tools.
        expect(router("api")).toEqual({
          path: "api",
          title: "Billing API",
          description: "Invoices and refunds",
          tags: { invoices: "Issued invoices" },
        });
        expect(tool("api.invoices.listInvoices")).toMatchObject({
          router: "api",
          readOnly: true,
          tags: ["invoices"],
        });
        expect(router("offline")?.error?._tag).toBe("McpError");

        const profile = yield* createProfile(actors.owner, path);
        const call = (name: string, kind: "query" | "mutation", input: Schema.Json = {}) =>
          api.request(actors.owner, "POST", `${path}/tools/call`, {
            profile: profile.id,
            tool: name,
            kind,
            input,
          });
        const closed = yield* call("issues.close", "mutation", { id: "7" });
        expect(closed.status).toBe(200);
        expect(closed.body).toEqual({ closed: "7" });
        // The caller names the kind, like an HTTP verb; the wrong one is rejected before running.
        const wrongKind = yield* call("issues.close", "query", { id: "8" });
        expect(wrongKind.status).toBe(409);
        expect(wrongKind.body).toMatchObject({
          _tag: "ToolKindMismatch",
          tool: "issues.close",
          requested: "query",
          actual: "mutation",
        });
        const searched = yield* call("docs.search.pages", "query");
        expect(searched.status).toBe(200);
        expect(searched.body).toMatchObject({ structuredContent: { tool: "search.pages" } });
        expect((yield* call("offline.anything", "query")).status).toBeGreaterThanOrEqual(400);

        // Reading a tool under the failed router reports the server's failure, not a missing tool.
        const hidden = yield* api.request(
          actors.owner,
          "GET",
          `${path}/tools/offline.anything?profile=${profile.id}`,
        );
        expect(hidden.status).not.toBe(404);
        expect(yield* body(Failure, hidden)).toMatchObject({ _tag: "AppEvaluationFailed" });
        expect((yield* body(Failure, hidden)).mcp).toBeDefined();

        // Router instructions, including the server's own, are published as skills in their own
        // namespace, beside an authored skill named like a router. Paths that slug alike get
        // distinct names, and the failed server contributes no skill.
        const flat = router("issue_notes")?.skill ?? "";
        expect(router("issue.notes")?.skill).toBe("tools-issue-notes");
        expect(flat).toMatch(/^tools-issue-notes-\d{10}$/);
        const skills = yield* body(
          Skills,
          yield* api.request(actors.owner, "GET", `${path}/skills`),
        );
        expect(skills.skills.map((skill) => skill.name).sort()).toEqual(
          ["issues", "tools-docs", "tools-issue-notes", flat, "tools-issues"].sort(),
        );
        const read = (name: string) =>
          api
            .request(actors.owner, "GET", `${path}/skills/${name}?profile=${profile.id}`)
            .pipe(Effect.flatMap((response) => body(Document, response)));
        expect((yield* read("tools-docs")).content).toContain(instructions);
        expect((yield* read("tools-issues")).content).toContain("Search before closing an issue.");
        expect((yield* read("issues")).content).toContain("Authored issues guide.");
        expect((yield* read("tools-issue-notes")).content).toContain("Nested notes.");
        expect((yield* read(flat)).content).toContain("Flat notes.");

        // Skills do not depend on the tool source: an app whose only source is down still
        // serves its authored skills, while its tools fail.
        const unreachable = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
            name: `Router down ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "package.json",
                content: JSON.stringify({
                  dependencies: withApps({
                    "@modelcontextprotocol/client": "2.0.0",
                    "@modelcontextprotocol/core": "2.0.0",
                  }),
                }),
              },
              {
                path: "index.ts",
                content: `import { defineApp } from "apps";
import { mcpRouter } from "apps/mcp";
export default defineApp({ accounts: {} }, async ({ signal }) => ({
  tools: await mcpRouter({ url: "http://127.0.0.1:9/mcp", signal }),
}));`,
              },
              authoredSkill("guide"),
            ],
          }),
        );
        const downPath = `${prefix}/${unreachable.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", downPath).pipe(Effect.orDie),
        );
        expect((yield* api.request(actors.owner, "GET", `${downPath}/tools`)).status).not.toBe(200);
        const downSkills = yield* api.request(actors.owner, "GET", `${downPath}/skills`);
        expect(downSkills.status).toBe(200);
        expect((yield* body(Skills, downSkills)).skills.map((skill) => skill.name)).toEqual([
          "guide",
        ]);

        // A key restricted to some tools sees only the routers that hold them. A failed router
        // appears only when the selection names a tool under it.
        const browser = yield* Browser;
        const oauth = yield* McpOAuth;
        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorizeApi;
        yield* Effect.addFinalizer(() => oauth.revoke(grant).pipe(Effect.orDie));
        const restricted = (names: readonly string[]) =>
          Effect.gen(function* () {
            const narrowed = yield* api.request(
              actors.owner,
              "POST",
              "/api/auth/mcp/grants/narrow",
              {
                id: grant.grantId,
                policy: {
                  kind: "tools",
                  apps: [{ app: app.id, tools: { kind: "selected", names } }],
                  approval: "client",
                },
              },
            );
            expect(narrowed.status).toBe(200);
            const response = yield* api.request(
              yield* api.session(),
              "GET",
              `${path}/tools`,
              undefined,
              { authorization: `Bearer ${Redacted.value(grant.tokens).access_token}` },
            );
            expect(response.status).toBe(200);
            const visible = yield* body(Catalog, response);
            return {
              tools: visible.items.map((item) => item.name),
              routers: visible.routers.map((entry) => entry.path).sort(),
            };
          });
        expect(yield* restricted(["issues.list", "offline.anything"])).toEqual({
          tools: ["issues.list"],
          routers: ["issues", "offline"],
        });
        expect(yield* restricted(["issues.list"])).toEqual({
          tools: ["issues.list"],
          routers: ["issues"],
        });

        // Agents see each tool's group in search, and a call into the failed router names it.
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", { name: "Routers" }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "app-routers", {
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
          "Search for a grouped tool",
          `return await tools.search({ query: "List open issues", namespace: ${JSON.stringify(app.slug)} });`,
        );
        const found = yield* Schema.decodeUnknownEffect(Search)(search.execution.value);
        expect(
          found.items.find((item) => item.path.endsWith(".issues.list"))?.description,
        ).toContain(" / Issues: List open issues");
        // The type an agent reads from search must accept what the same MCP tool returns.
        const docsTools = yield* execute(
          "Search and call the MCP server's tools",
          `const found = await tools.search({ query: "Synthetic", namespace: ${JSON.stringify(app.slug)} });
const docs = tools[${JSON.stringify(app.slug)}].docs;
return { items: found.items, lookup: await docs.lookup({}), pages: await docs.search.pages({}) };`,
        );
        const called = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            items: Search.fields.items,
            lookup: Schema.Json,
            pages: Schema.Json,
          }),
        )(docsTools.execution.value);
        const signature = (path: string) => {
          const found = called.items.find((item) => item.path.endsWith(path))?.signature;
          return found === undefined
            ? Effect.die(`Missing searched tool ${path}: ${JSON.stringify(called.items)}`)
            : Effect.succeed(found);
        };
        expect(
          outputContractProblems(
            yield* signature(".docs.lookup"),
            called.lookup,
            "const name: string = value.isError ? '' : value.structuredContent.tool;",
          ),
        ).toEqual([]);
        expect(
          outputContractProblems(
            yield* signature(".docs.search.pages"),
            called.pages,
            "const name: unknown = value.structuredContent?.tool;",
          ),
        ).toEqual([]);
        const failed = yield* execute(
          "Call a tool in the router whose server is down",
          `return await tools[${JSON.stringify(app.slug)}].offline.anything({});`,
        );
        expect(failed.execution.ok).toBe(false);
        expect(failed.unavailableApps).toContainEqual(
          expect.objectContaining({ app: app.id, router: "offline" }),
        );
      }).pipe(Effect.provide(Layer.merge(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
