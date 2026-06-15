// Selfhost · toolkit scope must narrow built-in core tools, not only dynamic
// connection tools. A scoped MCP session calling `connections.list` /
// `integrations.list` must see ONLY in-slice catalog rows; guessed out-of-slice
// dynamic addresses are blocked at execute; per-toolkit `require_approval`
// tightens the matching tool under that toolkit only.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeGreetingMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import type { McpSession } from "../src/surfaces/mcp";

const api = composePluginApi([mcpHttpPlugin(), toolkitsPlugin()] as const);
const ident = (prefix: string): string => `${prefix}${randomBytes(4).toString("hex")}`;

const isBlocked = (text: string): boolean => text.includes("tool_blocked");

const isSuccessfulGreeting = (text: string): boolean => text.includes("Hello from greeting MCP");

const listConnections = (session: McpSession) =>
  session.call("execute", {
    code: `
const list = await tools.executor.coreTools.connections.list({});
return JSON.stringify(list.ok ? list.data : { error: list.error });
`,
  });

const listIntegrations = (session: McpSession) =>
  session.call("execute", {
    code: `
const list = await tools.executor.coreTools.integrations.list({});
return JSON.stringify(list.ok ? list.data : { error: list.error });
`,
  });

scenario(
  "Toolkits · scoped MCP sessions narrow built-in connections.list and integrations.list",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      const addConnection = (slug: string, conn: string) =>
        Effect.gen(function* () {
          const token = `tok-${randomBytes(6).toString("hex")}`;
          const server = yield* serveMcpServer(() => makeGreetingMcpServer(), {
            auth: {
              validateAuthorization: (authorization) =>
                Effect.succeed(authorization === `Bearer ${token}`),
            },
          });
          yield* client.mcp.addServer({
            payload: {
              transport: "remote",
              name: `Greeting ${slug}`,
              endpoint: server.endpoint,
              slug,
              authenticationTemplate: [
                {
                  type: "apiKey",
                  headers: {
                    Authorization: ["Bearer ", { type: "variable", name: "token" }],
                  },
                },
              ],
            },
          });
          yield* client.connections.create({
            payload: {
              owner: "org",
              name: ConnectionName.make(conn),
              integration: IntegrationSlug.make(slug),
              template: AuthTemplateSlug.make("header"),
              value: token,
            },
          });
        });

      const slugIn = ident("corein");
      const slugOut = ident("coreout");
      const connIn = ident("conn");
      const connOut = ident("conn");
      yield* addConnection(slugIn, connIn);
      yield* addConnection(slugOut, connOut);

      const kit = yield* client.toolkits.create({
        payload: {
          slug: ident("corekit"),
          name: "Core scoped kit",
          scope: "workspace",
          connections: [
            {
              integration: IntegrationSlug.make(slugIn),
              connection: connIn,
              access: "full",
            },
          ],
        },
      });

      const scoped = mcp.session(identity, { toolkit: kit.slug });
      const bare = mcp.session(identity);

      const scopedConnsResult = yield* listConnections(scoped);
      const bareConnsResult = yield* listConnections(bare);
      expect(
        scopedConnsResult.ok,
        `scoped connections.list must succeed; text=${scopedConnsResult.text}`,
      ).toBe(true);

      const scopedConns = JSON.parse(scopedConnsResult.text) as {
        connections: ReadonlyArray<{ integration: string; name: string }>;
      };
      const bareConns = JSON.parse(bareConnsResult.text) as {
        connections: ReadonlyArray<{ integration: string; name: string }>;
      };

      expect(
        scopedConns.connections.map((c) => `${c.integration}/${c.name}`),
        "scoped connections.list shows only the in-slice connection",
      ).toEqual([`${slugIn}/${connIn}`]);
      expect(
        bareConns.connections.map((c) => `${c.integration}/${c.name}`),
        "bare connections.list still sees both connections",
      ).toEqual(expect.arrayContaining([`${slugIn}/${connIn}`, `${slugOut}/${connOut}`]));

      const scopedIntsResult = yield* listIntegrations(scoped);
      const bareIntsResult = yield* listIntegrations(bare);
      expect(
        scopedIntsResult.ok,
        `scoped integrations.list must succeed; text=${scopedIntsResult.text}`,
      ).toBe(true);

      const scopedInts = JSON.parse(scopedIntsResult.text) as {
        integrations: ReadonlyArray<{ slug: string }>;
      };
      const bareInts = JSON.parse(bareIntsResult.text) as {
        integrations: ReadonlyArray<{ slug: string }>;
      };

      const scopedSlugs = scopedInts.integrations.map((i) => i.slug);
      expect(scopedSlugs, "scoped integrations.list includes in-slice slug").toContain(slugIn);
      expect(scopedSlugs, "scoped integrations.list omits out-of-slice slug").not.toContain(
        slugOut,
      );

      const bareSlugs = bareInts.integrations.map((i) => i.slug);
      expect(bareSlugs, "bare integrations.list still sees both integrations").toEqual(
        expect.arrayContaining([slugIn, slugOut]),
      );

      const inSlice = yield* scoped.call("execute", {
        code: `return await tools.${slugIn}.org.${connIn}.simple_echo({});`,
      });
      expect(inSlice.ok, `in-slice tool runs; text=${inSlice.text}`).toBe(true);

      const outSlice = yield* scoped.call("execute", {
        code: `return await tools.${slugOut}.org.${connOut}.simple_echo({});`,
      });
      expect(
        isBlocked(outSlice.text),
        `guessed out-of-slice address must be tool_blocked; text=${outSlice.text}`,
      ).toBe(true);
      expect(
        isSuccessfulGreeting(outSlice.text),
        `out-of-slice must not run upstream; text=${outSlice.text}`,
      ).toBe(false);
      expect(
        outSlice.text.includes("suggestions"),
        `out-of-slice must not leak tool suggestions; text=${outSlice.text}`,
      ).toBe(false);
    }),
  ),
);

scenario(
  "Toolkits · scoped MCP sessions cannot create connections or policies",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      const slug = ident("adm");
      const conn = ident("conn");
      const token = `tok-${randomBytes(6).toString("hex")}`;
      const server = yield* serveMcpServer(() => makeGreetingMcpServer(), {
        auth: {
          validateAuthorization: (authorization) =>
            Effect.succeed(authorization === `Bearer ${token}`),
        },
      });
      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: `Greeting ${slug}`,
          endpoint: server.endpoint,
          slug,
          authenticationTemplate: [
            {
              type: "apiKey",
              headers: {
                Authorization: ["Bearer ", { type: "variable", name: "token" }],
              },
            },
          ],
        },
      });
      yield* client.connections.create({
        payload: {
          owner: "org",
          name: ConnectionName.make(conn),
          integration: IntegrationSlug.make(slug),
          template: AuthTemplateSlug.make("header"),
          value: token,
        },
      });

      const kit = yield* client.toolkits.create({
        payload: {
          slug: ident("admkit"),
          name: "Admin blocked kit",
          scope: "workspace",
          connections: [
            {
              integration: IntegrationSlug.make(slug),
              connection: conn,
              access: "full",
            },
          ],
        },
      });

      const scoped = mcp.session(identity, { toolkit: kit.slug });
      const newConn = ident("newconn");

      const createConn = yield* scoped.call("execute", {
        code: `
const result = await tools.executor.coreTools.connections.create({
  owner: "org",
  integration: "${slug}",
  name: "${newConn}",
  template: "header",
  value: "blocked-token",
});
return JSON.stringify(result.ok ? result.data : { error: result.error });
`,
      });
      expect(
        isBlocked(createConn.text),
        `scoped connections.create blocked; text=${createConn.text}`,
      ).toBe(true);

      const createPolicy = yield* scoped.call("execute", {
        code: `
const result = await tools.executor.coreTools.policies.create({
  owner: "org",
  pattern: "${slug}.*",
  action: "block",
});
return JSON.stringify(result.ok ? result.data : { error: result.error });
`,
      });
      expect(
        isBlocked(createPolicy.text),
        `scoped policies.create blocked; text=${createPolicy.text}`,
      ).toBe(true);
    }),
  ),
);

scenario(
  "Toolkits · a per-toolkit require_approval rule pauses only under that toolkit",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      const slug = ident("appr");
      const conn = ident("conn");
      const token = `tok-${randomBytes(6).toString("hex")}`;
      const server = yield* serveMcpServer(() => makeGreetingMcpServer(), {
        auth: {
          validateAuthorization: (authorization) =>
            Effect.succeed(authorization === `Bearer ${token}`),
        },
      });
      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: `Greeting ${slug}`,
          endpoint: server.endpoint,
          slug,
          authenticationTemplate: [
            {
              type: "apiKey",
              headers: {
                Authorization: ["Bearer ", { type: "variable", name: "token" }],
              },
            },
          ],
        },
      });
      yield* client.connections.create({
        payload: {
          owner: "org",
          name: ConnectionName.make(conn),
          integration: IntegrationSlug.make(slug),
          template: AuthTemplateSlug.make("header"),
          value: token,
        },
      });

      const gated = yield* client.toolkits.create({
        payload: {
          slug: ident("kitappr"),
          name: "Approval gated",
          scope: "workspace",
          connections: [
            {
              integration: IntegrationSlug.make(slug),
              connection: conn,
              access: "full",
            },
          ],
          policies: [
            {
              pattern: `${slug}.${conn}.simple_echo`,
              action: "require_approval",
            },
          ],
        },
      });

      const code = `return await tools.${slug}.org.${conn}.simple_echo({});`;

      const bareRun = yield* mcp.session(identity).call("execute", { code });
      expect(
        bareRun.ok && !bareRun.text.includes("Execution paused"),
        `bare session runs without toolkit approval gate; text=${bareRun.text}`,
      ).toBe(true);

      const gatedRun = yield* mcp
        .session(identity, { toolkit: gated.slug })
        .call("execute", { code });
      expect(
        gatedRun.text,
        `toolkit require_approval pauses execution; text=${gatedRun.text}`,
      ).toContain("Execution paused");
    }),
  ),
);
