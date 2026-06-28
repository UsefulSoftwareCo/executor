import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import type { McpSession } from "../src/surfaces/mcp";

const api = composePluginApi([openApiHttpPlugin(), toolkitsPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

const pingSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Toolkit Ping API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/ping/{id}": {
        get: {
          operationId: "getPing",
          summary: "Return a ping payload",
          security: [{ apiKey: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "A ping payload",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      path: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "x-e2e-token" },
      },
    },
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

const servePingApi = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly url: string; readonly server: Server }>((resolve) => {
        const server = createServer((request, response) => {
          const url = new URL(request.url ?? "/", "http://127.0.0.1");
          if (request.method === "GET" && url.pathname.startsWith("/ping/")) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                id: decodeURIComponent(url.pathname.slice("/ping/".length)),
                path: url.pathname,
              }),
            );
            return;
          }
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "not_found" }));
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address() as AddressInfo;
          resolve({ url: `http://127.0.0.1:${address.port}`, server });
        });
      }),
  ),
  ({ server }) => Effect.promise(() => closeServer(server)).pipe(Effect.ignore),
);

const toolkitUrl = (baseUrl: string, slug: string): string =>
  new URL(`/mcp/toolkits/${slug}`, baseUrl).toString();

const connectionPattern = (integration: string, owner: "org" | "user", name: string): string =>
  `${integration}.${owner}.${name}.*`;

const executeJson = (session: McpSession, code: string) =>
  Effect.gen(function* () {
    const result = yield* session.call("execute", { code });
    expect(result.ok, `execute completed (got: ${result.text.slice(0, 500)})`).toBe(true);
    return JSON.parse(result.text) as Record<string, unknown>;
  });

const callPingCode = (input: {
  readonly integration: string;
  readonly owner: "org" | "user";
  readonly connection: string;
  readonly id: string;
}) => `
const listed = await tools.search({ namespace: ${JSON.stringify(input.integration)}, query: "ping", limit: 100 });
const expected = ${JSON.stringify(`${input.integration}.${input.owner}.${input.connection}.`)};
const path = listed.items.map((item) => item.path).find((candidate) => candidate.startsWith(expected));
if (!path) return { ok: false, reason: "missing", expected, paths: listed.items.map((item) => item.path).sort() };
let tool = tools;
for (const segment of path.split(".")) tool = tool?.[segment];
if (typeof tool !== "function") return { ok: false, reason: "not-callable", path };
const result = await tool({ id: ${JSON.stringify(input.id)} });
return { ok: result.ok, path, data: result.ok ? result.data : result.error };
`;

const visibleConnectionPathsCode = (integration: string) => `
const listed = await tools.search({ namespace: ${JSON.stringify(integration)}, query: "ping", limit: 100 });
return { paths: listed.items.map((item) => item.path).sort() };
`;

const createPolicyCode = (input: {
  readonly pattern: string;
  readonly action: "approve" | "require_approval" | "block";
}) => `
const created = await tools.executor.coreTools.policies.create({
  owner: "user",
  pattern: ${JSON.stringify(input.pattern)},
  action: ${JSON.stringify(input.action)},
});
return JSON.stringify({ ok: created.ok, data: created.ok ? created.data : null, error: created.ok ? null : created.error });
`;

const assertCallOk = (value: Record<string, unknown>, label: string) => {
  expect(value.ok, `${label}: ${JSON.stringify(value)}`).toBe(true);
};

const assertCallMissing = (value: Record<string, unknown>, label: string) => {
  expect(value.ok, `${label}: ${JSON.stringify(value)}`).toBe(false);
  expect(value.reason, `${label} is missing from the toolkit catalog`).toBe("missing");
};

scenario(
  "Toolkits · OAuth metadata and challenges stay scoped to the toolkit endpoint",
  { timeout: 60_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const slug = unique("metadata-kit");
    const mcpUrl = new URL(`/mcp/toolkits/${slug}`, target.baseUrl);
    const metadataUrl = new URL(
      `/.well-known/oauth-protected-resource/mcp/toolkits/${slug}`,
      target.baseUrl,
    );

    const metadataResponse = yield* Effect.promise(() => fetch(metadataUrl));
    expect(metadataResponse.status, "toolkit protected-resource metadata is served").toBe(200);
    const metadata = (yield* Effect.promise(() => metadataResponse.json())) as Record<
      string,
      unknown
    >;
    expect(metadata.resource, "metadata advertises the toolkit MCP resource").toBe(
      mcpUrl.toString(),
    );
    expect(
      Array.isArray(metadata.authorization_servers),
      "metadata still advertises authorization servers",
    ).toBe(true);

    if (target.name === "cloudflare") return;

    const challenged = yield* Effect.promise(() =>
      fetch(mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
    );
    expect(challenged.status, "unauthenticated toolkit MCP requests are challenged").toBe(401);
    expect(
      challenged.headers.get("www-authenticate") ?? "",
      "challenge points clients at toolkit metadata",
    ).toContain(metadataUrl.toString());
  }),
);

scenario(
  "Toolkits · workspace and personal MCP endpoints expose the right connection sets",
  { timeout: 240_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const { client: makeClient } = yield* Api;
      const upstream = yield* servePingApi;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);

      const integration = unique("toolkit_ping");
      const workspaceToolkitName = unique("workspace-kit");
      const personalToolkitName = unique("personal-kit");
      const workspaceConnections = Array.from({ length: 30 }, (_, index) => `shared${index}`);
      const personalConnection = "mine";

      yield* Effect.gen(function* () {
        yield* client.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: pingSpec(upstream.url) },
            slug: IntegrationSlug.make(integration),
            baseUrl: upstream.url,
            authenticationTemplate: [
              {
                slug: "apiKey",
                type: "apiKey",
                headers: { "x-e2e-token": [{ type: "variable", name: "token" }] },
              },
            ],
          },
        });

        for (const name of workspaceConnections) {
          yield* client.connections.create({
            payload: {
              owner: "org",
              name: ConnectionName.make(name),
              integration: IntegrationSlug.make(integration),
              template: AuthTemplateSlug.make("apiKey"),
              value: "unused-token",
            },
          });
        }
        yield* client.connections.create({
          payload: {
            owner: "user",
            name: ConnectionName.make(personalConnection),
            integration: IntegrationSlug.make(integration),
            template: AuthTemplateSlug.make("apiKey"),
            value: "unused-token",
          },
        });

        const workspaceToolkit = yield* client.toolkits.create({
          payload: { owner: "org", name: workspaceToolkitName },
        });
        for (const name of workspaceConnections) {
          yield* client.toolkits.createConnection({
            params: { toolkitId: workspaceToolkit.id },
            payload: { pattern: connectionPattern(integration, "org", name) },
          });
        }
        yield* client.toolkits.createConnection({
          params: { toolkitId: workspaceToolkit.id },
          payload: { pattern: connectionPattern(integration, "user", personalConnection) },
        });

        const personalToolkit = yield* client.toolkits.create({
          payload: { owner: "user", name: personalToolkitName },
        });
        yield* client.toolkits.createConnection({
          params: { toolkitId: personalToolkit.id },
          payload: { pattern: connectionPattern(integration, "org", workspaceConnections[0]!) },
        });
        yield* client.toolkits.createConnection({
          params: { toolkitId: personalToolkit.id },
          payload: { pattern: connectionPattern(integration, "user", personalConnection) },
        });

        const workspaceSession = mcp.session(identity, {
          url: toolkitUrl(target.baseUrl, workspaceToolkit.slug),
        });
        const personalSession = mcp.session(identity, {
          url: toolkitUrl(target.baseUrl, personalToolkit.slug),
        });

        const workspacePaths = yield* executeJson(
          workspaceSession,
          visibleConnectionPathsCode(integration),
        );
        const paths = workspacePaths.paths as string[];
        expect(paths.length, "workspace toolkit exposes every workspace connection").toBe(
          workspaceConnections.length,
        );
        for (const name of workspaceConnections) {
          expect(paths, `workspace toolkit includes ${name}`).toContain(
            `${integration}.org.${name}.ping.getPing`,
          );
        }
        expect(
          paths,
          "workspace toolkit does not expose a personal connection even when its pattern was added",
        ).not.toContain(`${integration}.user.${personalConnection}.ping.getPing`);

        const workspaceCall = yield* executeJson(
          workspaceSession,
          callPingCode({
            integration,
            owner: "org",
            connection: workspaceConnections[3]!,
            id: "workspace-call",
          }),
        );
        assertCallOk(workspaceCall, "workspace connection is callable");

        const lateWorkspaceCall = yield* executeJson(
          workspaceSession,
          callPingCode({
            integration,
            owner: "org",
            connection: workspaceConnections.at(-1)!,
            id: "workspace-late-call",
          }),
        );
        assertCallOk(lateWorkspaceCall, "late workspace connection is callable");

        const personalBlockedFromWorkspace = yield* executeJson(
          workspaceSession,
          callPingCode({
            integration,
            owner: "user",
            connection: personalConnection,
            id: "workspace-personal-blocked",
          }),
        );
        assertCallMissing(personalBlockedFromWorkspace, "workspace toolkit blocks personal tools");

        const personalWorkspaceCall = yield* executeJson(
          personalSession,
          callPingCode({
            integration,
            owner: "org",
            connection: workspaceConnections[0]!,
            id: "personal-workspace-call",
          }),
        );
        assertCallOk(personalWorkspaceCall, "personal toolkit can call a workspace connection");

        const personalPaths = yield* executeJson(
          personalSession,
          visibleConnectionPathsCode(integration),
        );
        const personalVisiblePaths = personalPaths.paths as string[];
        expect(
          personalVisiblePaths,
          "personal toolkit includes its selected workspace tool",
        ).toContain(`${integration}.org.${workspaceConnections[0]}.ping.getPing`);
        expect(
          personalVisiblePaths,
          "personal toolkit excludes unselected workspace tools from the same integration",
        ).not.toContain(`${integration}.org.${workspaceConnections[1]}.ping.getPing`);

        const personalOwnCall = yield* executeJson(
          personalSession,
          callPingCode({
            integration,
            owner: "user",
            connection: personalConnection,
            id: "personal-own-call",
          }),
        );
        assertCallOk(personalOwnCall, "personal toolkit can call a personal connection");
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const listed = yield* client.toolkits.list();
            yield* Effect.forEach(
              listed.toolkits.filter((toolkit) =>
                [workspaceToolkitName, personalToolkitName].includes(toolkit.name),
              ),
              (toolkit) => client.toolkits.remove({ params: { toolkitId: toolkit.id } }),
              { discard: true },
            );
            yield* client.openapi.removeSpec({ params: { slug: integration } }).pipe(Effect.ignore);
          }).pipe(Effect.ignore),
        ),
      );
    }),
  ),
);

scenario(
  "Toolkits · an open MCP session follows toolkit connection add and remove changes",
  { timeout: 240_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const { client: makeClient } = yield* Api;
      const upstream = yield* servePingApi;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);

      const integration = unique("toolkit_live");
      const toolkitName = unique("live-session-kit");
      const connection = "main";

      yield* Effect.gen(function* () {
        yield* client.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: pingSpec(upstream.url) },
            slug: IntegrationSlug.make(integration),
            baseUrl: upstream.url,
            authenticationTemplate: [
              {
                slug: "apiKey",
                type: "apiKey",
                headers: { "x-e2e-token": [{ type: "variable", name: "token" }] },
              },
            ],
          },
        });
        yield* client.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make(connection),
            integration: IntegrationSlug.make(integration),
            template: AuthTemplateSlug.make("apiKey"),
            value: "unused-token",
          },
        });

        const toolkit = yield* client.toolkits.create({
          payload: { owner: "org", name: toolkitName },
        });
        const pattern = connectionPattern(integration, "org", connection);

        const session = mcp.session(identity, { url: toolkitUrl(target.baseUrl, toolkit.slug) });

        const initiallyMissing = yield* executeJson(
          session,
          callPingCode({ integration, owner: "org", connection, id: "before-add" }),
        );
        assertCallMissing(initiallyMissing, "empty toolkit does not expose the connection");

        const toolkitConnection = yield* client.toolkits.createConnection({
          params: { toolkitId: toolkit.id },
          payload: { pattern },
        });
        const afterFirstAdd = yield* executeJson(
          session,
          callPingCode({ integration, owner: "org", connection, id: "after-first-add" }),
        );
        assertCallOk(afterFirstAdd, "same MCP session sees a newly added connection");

        yield* client.toolkits.removeConnection({
          params: { toolkitId: toolkit.id, connectionId: toolkitConnection.id },
        });
        const removed = yield* executeJson(
          session,
          callPingCode({ integration, owner: "org", connection, id: "after-remove" }),
        );
        assertCallMissing(removed, "same MCP session loses the removed connection");

        yield* client.toolkits.createConnection({
          params: { toolkitId: toolkit.id },
          payload: { pattern },
        });
        const afterAdd = yield* executeJson(
          session,
          callPingCode({ integration, owner: "org", connection, id: "after-add" }),
        );
        assertCallOk(afterAdd, "same MCP session sees the re-added connection");
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const listed = yield* client.toolkits.list();
            yield* Effect.forEach(
              listed.toolkits.filter((toolkit) => toolkit.name === toolkitName),
              (toolkit) => client.toolkits.remove({ params: { toolkitId: toolkit.id } }),
              { discard: true },
            );
            yield* client.openapi.removeSpec({ params: { slug: integration } }).pipe(Effect.ignore);
          }).pipe(Effect.ignore),
        ),
      );
    }),
  ),
);

scenario(
  "Toolkits · approve and block policies change destructive core-tool side effects",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);

    const approveToolkitName = unique("approve-core-tools-kit");
    const blockToolkitName = unique("block-core-tools-kit");
    const approvedPattern = `${unique("toolkit-approved-policy")}.*`;
    const blockedPattern = `${unique("toolkit-blocked-policy")}.*`;

    yield* Effect.gen(function* () {
      const approveToolkit = yield* client.toolkits.create({
        payload: { owner: "org", name: approveToolkitName },
      });
      yield* client.toolkits.createConnection({
        params: { toolkitId: approveToolkit.id },
        payload: { pattern: "executor.coreTools.*" },
      });
      yield* client.toolkits.createPolicy({
        params: { toolkitId: approveToolkit.id },
        payload: { pattern: "executor.coreTools.policies.create", action: "approve" },
      });

      const approveSession = mcp.session(identity, {
        url: toolkitUrl(target.baseUrl, approveToolkit.slug),
      });
      const approved = yield* approveSession.call("execute", {
        code: createPolicyCode({ pattern: approvedPattern, action: "block" }),
      });
      expect(approved.text, "approved policy create does not pause for approval").not.toContain(
        "Execution paused",
      );
      expect(approved.text, "approved policy create does not return an execution id").not.toContain(
        "executionId:",
      );
      expect(approved.ok, `approved policy create succeeded: ${approved.text}`).toBe(true);
      const approvedPayload = JSON.parse(approved.text) as Record<string, unknown>;
      expect(approvedPayload.ok, `approved policy create result: ${approved.text}`).toBe(true);
      const afterApproved = yield* client.policies.list();
      expect(
        afterApproved.map((policy) => `${policy.owner} ${policy.pattern} ${policy.action}`),
        "approved toolkit policy created the user policy",
      ).toContain(`user ${approvedPattern} block`);

      const blockToolkit = yield* client.toolkits.create({
        payload: { owner: "org", name: blockToolkitName },
      });
      yield* client.toolkits.createConnection({
        params: { toolkitId: blockToolkit.id },
        payload: { pattern: "executor.coreTools.*" },
      });
      yield* client.toolkits.createPolicy({
        params: { toolkitId: blockToolkit.id },
        payload: { pattern: "executor.coreTools.policies.create", action: "block" },
      });

      const blockSession = mcp.session(identity, {
        url: toolkitUrl(target.baseUrl, blockToolkit.slug),
      });
      const blocked = yield* blockSession.call("execute", {
        code: createPolicyCode({ pattern: blockedPattern, action: "block" }),
      });
      expect(blocked.text, "blocked policy create does not pause for approval").not.toContain(
        "Execution paused",
      );
      const afterBlocked = yield* client.policies.list();
      expect(
        afterBlocked.map((policy) => `${policy.owner} ${policy.pattern} ${policy.action}`),
        "blocked toolkit policy prevents the user policy side effect",
      ).not.toContain(`user ${blockedPattern} block`);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const listed = yield* client.toolkits.list();
          yield* Effect.forEach(
            listed.toolkits.filter((toolkit) =>
              [approveToolkitName, blockToolkitName].includes(toolkit.name),
            ),
            (toolkit) => client.toolkits.remove({ params: { toolkitId: toolkit.id } }),
            { discard: true },
          );
          const policies = yield* client.policies.list();
          yield* Effect.forEach(
            policies.filter((policy) => [approvedPattern, blockedPattern].includes(policy.pattern)),
            (policy) =>
              client.policies.remove({
                params: { policyId: policy.id },
                payload: { owner: policy.owner },
              }),
            { discard: true },
          );
        }).pipe(Effect.ignore),
      ),
    );
  }),
);
