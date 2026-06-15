// Selfhost · Slice 3 (keystone): a toolkit narrows the MCP engine. Connecting
// to /mcp?toolkit=<slug> exposes ONLY the toolkit's slice — the execute tool's
// inventory omits out-of-slice connections, and an out-of-slice tool is blocked
// at execute (not merely hidden), proving enforcement is at the executor, not
// just listing. A bare session (no selector) is unchanged.
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
// Identifier-safe (no hyphens) so the sandbox `tools.<int>.<owner>.<conn>.<tool>`
// dotted path stays valid JS.
const ident = (prefix: string): string => `${prefix}${randomBytes(4).toString("hex")}`;

const describeExecute = (defs: ReadonlyArray<{ name: string; description?: string }>): string =>
  defs.find((d) => d.name === "execute")?.description ?? "";

scenario(
  "Toolkits · an MCP session scoped to a toolkit sees only its slice; out-of-slice is blocked",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      // Stand up two real MCP greeting servers -> two integrations + org
      // connections (each exposes a `simple_echo` tool discovered at create).
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

      const slugIn = ident("tkin");
      const slugOut = ident("tkout");
      const connIn = ident("conn");
      const connOut = ident("conn");
      yield* addConnection(slugIn, connIn);
      yield* addConnection(slugOut, connOut);

      // A workspace toolkit that includes ONLY the first connection.
      const kit = yield* client.toolkits.create({
        payload: {
          slug: ident("kit"),
          name: "Scoped kit",
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

      // Scoped session: inventory shows the in-slice integration, not the other.
      const scoped = mcp.session(identity, { toolkit: kit.slug });
      const scopedDesc = describeExecute(yield* scoped.describeTools());
      expect(scopedDesc, "scoped inventory includes the in-slice integration").toContain(slugIn);
      expect(scopedDesc, "scoped inventory omits the out-of-slice integration").not.toContain(
        slugOut,
      );

      // In-slice tool runs; out-of-slice tool is blocked at execute (even though
      // the agent guessed its address).
      const inSlice = yield* scoped.call("execute", {
        code: `return await tools.${slugIn}.org.${connIn}.simple_echo({});`,
      });
      expect(inSlice.ok, `in-slice tool executes; text=${inSlice.text}`).toBe(true);

      const outSlice = yield* scoped.call("execute", {
        code: `return await tools.${slugOut}.org.${connOut}.simple_echo({});`,
      });
      // Blocked tools surface as an error (thrown or an error envelope) — never
      // the successful greeting the in-slice call returns.
      expect(
        outSlice.text,
        `out-of-slice must be blocked; in.text=${inSlice.text} out.ok=${outSlice.ok} out.text=${outSlice.text}`,
      ).not.toBe(inSlice.text);

      // Bare session (no selector) is unchanged — both integrations visible.
      const bareDesc = describeExecute(yield* mcp.session(identity).describeTools());
      expect(bareDesc, "bare /mcp still sees the first integration").toContain(slugIn);
      expect(bareDesc, "bare /mcp still sees the second integration").toContain(slugOut);
    }),
  ),
);
