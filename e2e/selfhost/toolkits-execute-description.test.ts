// Selfhost · the execute tool's DESCRIPTION accurately reflects a toolkit's
// slice. An MCP client reads this description to learn what it can call; if it
// still listed out-of-slice connections, a scoped agent would chase addresses
// it cannot run. The execute description's "Available connection prefixes"
// inventory (`<integration>.<owner>.<connection>` paths) must therefore name
// exactly the toolkit's connections — A and B (in the kit), never C (out) —
// while a bare session, with no selector, still advertises C. This is the
// "the description on MCP clients is right" coverage for toolkit narrowing.
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
// dotted path — and the description's connection-prefix inventory — stay valid.
const ident = (prefix: string): string => `${prefix}${randomBytes(4).toString("hex")}`;

const describeExecute = (defs: ReadonlyArray<{ name: string; description?: string }>): string =>
  defs.find((d) => d.name === "execute")?.description ?? "";

scenario(
  "Toolkits · the MCP execute tool's description lists exactly the toolkit's connection slice",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      // Stand up three real MCP greeting servers -> three distinct integrations
      // + org connections (each exposes a `simple_echo` tool discovered at
      // create). Connection names are normalized on create (hyphens removed +
      // camelCased), so we keep them lowercase-alphanumeric to round-trip
      // unchanged into the description's prefix.
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

      // A and B go in the toolkit (at "full" and "read" respectively); C does not.
      const slugA = ident("tka");
      const slugB = ident("tkb");
      const slugC = ident("tkc");
      const connA = ident("conn");
      const connB = ident("conn");
      const connC = ident("conn");
      yield* addConnection(slugA, connA);
      yield* addConnection(slugB, connB);
      yield* addConnection(slugC, connC);

      // A workspace (org-owned) toolkit: A at "full", B at "read", C omitted.
      const kit = yield* client.toolkits.create({
        payload: {
          slug: ident("kit"),
          name: "Slice kit",
          scope: "workspace",
          connections: [
            {
              integration: IntegrationSlug.make(slugA),
              connection: connA,
              access: "full",
            },
            {
              integration: IntegrationSlug.make(slugB),
              connection: connB,
              access: "read",
            },
          ],
        },
      });

      // The description lists connection prefixes as `<integration>.<owner>.<connection>`
      // (the `tools.` root is stripped). Workspace connections are owner "org".
      const prefixA = `${slugA}.org.${connA}`;
      const prefixB = `${slugB}.org.${connB}`;
      const prefixC = `${slugC}.org.${connC}`;

      // Scoped session: the execute description names A and B, never C.
      const scoped = mcp.session(identity, { toolkit: kit.slug });
      const scopedDefs = yield* scoped.describeTools();
      const scopedDesc = describeExecute(scopedDefs);

      expect(
        scopedDesc,
        `scoped execute description names the full-access connection (A)`,
      ).toContain(prefixA);
      expect(
        scopedDesc,
        `scoped execute description names the read-access connection (B)`,
      ).toContain(prefixB);
      expect(
        scopedDesc,
        `scoped execute description must NOT name the out-of-slice connection (C)`,
      ).not.toContain(prefixC);
      // Defense-in-depth: even the bare integration slug for C must not leak into
      // the scoped inventory (it never appears in any other prefix).
      expect(scopedDesc, `scoped inventory omits C's integration entirely`).not.toContain(slugC);

      // The execute tool itself is still advertised on the scoped session — the
      // slice narrows its inventory, it does not remove the tool.
      const scopedToolNames = yield* scoped.listTools();
      expect(scopedToolNames, "scoped session still advertises execute").toContain("execute");

      // Bare session (no selector): the description DOES name C — proving the
      // scoped omission above is genuine narrowing, not C being absent globally.
      const bareDefs = yield* mcp.session(identity).describeTools();
      const bareDesc = describeExecute(bareDefs);
      expect(bareDesc, "bare execute description names A").toContain(prefixA);
      expect(bareDesc, "bare execute description names B").toContain(prefixB);
      expect(
        bareDesc,
        "bare execute description names the out-of-slice connection C (no narrowing)",
      ).toContain(prefixC);
    }),
  ),
);
