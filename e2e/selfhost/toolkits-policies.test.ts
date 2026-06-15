// Selfhost · Slice 4: per-toolkit policies + access modes at execute time.
//   - full access  -> the connection's tool runs;
//   - a `block` policy on that tool -> blocked at execute (exclusion);
//   - read-only access -> an unclassified (non-read-only) tool is blocked
//     (fail-closed: unclassified counts as write).
// One greeting connection, three toolkits over it, compared via MCP execute.
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

const api = composePluginApi([mcpHttpPlugin(), toolkitsPlugin()] as const);
const ident = (prefix: string): string => `${prefix}${randomBytes(4).toString("hex")}`;

scenario(
  "Toolkits · access modes + block policies are enforced at execute",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      const slug = ident("pol");
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
              headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
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

      const full = yield* client.toolkits.create({
        payload: {
          slug: ident("kitfull"),
          name: "Full",
          scope: "workspace",
          connections: [
            { integration: IntegrationSlug.make(slug), connection: conn, access: "full" },
          ],
        },
      });
      const blocked = yield* client.toolkits.create({
        payload: {
          slug: ident("kitblock"),
          name: "Blocked",
          scope: "workspace",
          connections: [
            { integration: IntegrationSlug.make(slug), connection: conn, access: "full" },
          ],
          policies: [{ pattern: `${slug}.${conn}.simple_echo`, action: "block" }],
        },
      });
      const readonly = yield* client.toolkits.create({
        payload: {
          slug: ident("kitread"),
          name: "Read",
          scope: "workspace",
          connections: [
            { integration: IntegrationSlug.make(slug), connection: conn, access: "read" },
          ],
        },
      });

      const code = `return await tools.${slug}.org.${conn}.simple_echo({});`;
      const fullCall = yield* mcp
        .session(identity, { toolkit: full.slug })
        .call("execute", { code });
      const blockCall = yield* mcp
        .session(identity, { toolkit: blocked.slug })
        .call("execute", { code });
      const readCall = yield* mcp
        .session(identity, { toolkit: readonly.slug })
        .call("execute", { code });

      expect(fullCall.ok, `full access runs the tool; text=${fullCall.text}`).toBe(true);
      expect(
        blockCall.text,
        `block policy must stop the tool; full=${fullCall.text} block=${blockCall.text}`,
      ).not.toBe(fullCall.text);
      expect(
        readCall.text,
        `read-only must hide an unclassified (write) tool; full=${fullCall.text} read=${readCall.text}`,
      ).not.toBe(fullCall.text);
    }),
  ),
);
