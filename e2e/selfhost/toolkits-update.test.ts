// Selfhost · Slice 3 (live re-narrowing): updating a toolkit's connection set
// changes what a NEWLY-opened scoped MCP session sees. `connections` on the
// update payload is a FULL REPLACEMENT (server.ts update(): when
// patch.connections is defined it deletes every existing connection row and
// re-inserts the patch list), so to drop a connection you OMIT it. A session
// opened BEFORE an update keeps its original slice — each transition is proven
// against a FRESH mcp.session, and read back via toolkits.get to confirm the
// persisted set matches.
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
// dotted path stays valid JS; also satisfies the create-time name normalization.
const ident = (prefix: string): string => `${prefix}${randomBytes(4).toString("hex")}`;

const describeExecute = (defs: ReadonlyArray<{ name: string; description?: string }>): string =>
  defs.find((d) => d.name === "execute")?.description ?? "";

scenario(
  "Toolkits · updating a toolkit's connections re-narrows what a fresh MCP session sees",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      // Two real MCP greeting servers -> two distinct integrations + org
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

      // A = the first integration/connection, B = the second.
      const slugA = ident("tka");
      const slugB = ident("tkb");
      const connA = ident("conn");
      const connB = ident("conn");
      yield* addConnection(slugA, connA);
      yield* addConnection(slugB, connB);

      const codeA = `return await tools.${slugA}.org.${connA}.simple_echo({});`;
      const codeB = `return await tools.${slugB}.org.${connB}.simple_echo({});`;

      // Workspace toolkit with ONLY A at "full".
      const kit = yield* client.toolkits.create({
        payload: {
          slug: ident("kit"),
          name: "Evolving kit",
          scope: "workspace",
          connections: [
            {
              integration: IntegrationSlug.make(slugA),
              connection: connA,
              access: "full",
            },
          ],
        },
      });

      // A baseline "what a runnable in-slice greeting looks like" so we can
      // distinguish a real greeting from a blocked error envelope (blocked
      // tools surface as an error in .text, never the greeting).
      // ---- Session #1: only A in slice ------------------------------------
      const s1 = mcp.session(identity, { toolkit: kit.slug });
      const desc1 = describeExecute(yield* s1.describeTools());
      expect(desc1, "#1 inventory includes A").toContain(slugA);
      expect(desc1, "#1 inventory omits B").not.toContain(slugB);

      const s1A = yield* s1.call("execute", { code: codeA });
      expect(s1A.ok, `#1 A executes; text=${s1A.text}`).toBe(true);
      const greeting = s1A.text; // the canonical success text for simple_echo

      const s1B = yield* s1.call("execute", { code: codeB });
      expect(
        s1B.text,
        `#1 B must be blocked (not the greeting); B.ok=${s1B.ok} B.text=${s1B.text}`,
      ).not.toBe(greeting);

      // Persisted set after create: exactly A.
      const view1 = yield* client.toolkits.get({ params: { id: kit.id } });
      expect(view1.connections.map((c) => c.integration).sort(), "#1 persisted = [A]").toEqual(
        [slugA].sort(),
      );

      // ---- Update -> [A full, B full]; Session #2 (fresh): BOTH present ----
      const upd2 = yield* client.toolkits.update({
        params: { id: kit.id },
        payload: {
          connections: [
            {
              integration: IntegrationSlug.make(slugA),
              connection: connA,
              access: "full",
            },
            {
              integration: IntegrationSlug.make(slugB),
              connection: connB,
              access: "full",
            },
          ],
        },
      });
      expect(upd2.connections.map((c) => c.integration).sort(), "update#2 echoes [A,B]").toEqual(
        [slugA, slugB].sort(),
      );

      const view2 = yield* client.toolkits.get({ params: { id: kit.id } });
      expect(view2.connections.map((c) => c.integration).sort(), "#2 persisted = [A,B]").toEqual(
        [slugA, slugB].sort(),
      );

      const s2 = mcp.session(identity, { toolkit: kit.slug });
      const desc2 = describeExecute(yield* s2.describeTools());
      expect(desc2, "#2 inventory includes A").toContain(slugA);
      expect(desc2, "#2 inventory now includes B").toContain(slugB);

      const s2A = yield* s2.call("execute", { code: codeA });
      expect(s2A.ok, `#2 A still runnable; text=${s2A.text}`).toBe(true);
      const s2B = yield* s2.call("execute", { code: codeB });
      expect(s2B.ok, `#2 B now runnable; text=${s2B.text}`).toBe(true);
      expect(s2B.text, "#2 B returns the greeting, not an error").toBe(greeting);

      // ---- Update -> [B full] only (A dropped == off); Session #3 fresh ---
      const upd3 = yield* client.toolkits.update({
        params: { id: kit.id },
        payload: {
          connections: [
            {
              integration: IntegrationSlug.make(slugB),
              connection: connB,
              access: "full",
            },
          ],
        },
      });
      expect(
        upd3.connections.map((c) => c.integration),
        "update#3 echoes [B] only — full replacement dropped A",
      ).toEqual([slugB]);

      const view3 = yield* client.toolkits.get({ params: { id: kit.id } });
      expect(
        view3.connections.map((c) => c.integration),
        "#3 persisted = [B] only",
      ).toEqual([slugB]);

      const s3 = mcp.session(identity, { toolkit: kit.slug });
      const desc3 = describeExecute(yield* s3.describeTools());
      expect(desc3, "#3 inventory includes B").toContain(slugB);
      expect(desc3, "#3 inventory now omits A").not.toContain(slugA);

      const s3B = yield* s3.call("execute", { code: codeB });
      expect(s3B.ok, `#3 B runnable; text=${s3B.text}`).toBe(true);
      const s3A = yield* s3.call("execute", { code: codeA });
      // A is out-of-slice again -> blocked at execute (error envelope in .text),
      // never the greeting the in-slice call returns.
      expect(
        s3A.text,
        `#3 A must be blocked after being dropped; A.ok=${s3A.ok} A.text=${s3A.text}`,
      ).not.toBe(greeting);
    }),
  ),
);
