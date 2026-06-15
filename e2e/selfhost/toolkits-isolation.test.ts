// Selfhost · Toolkit slice isolation: two toolkits over OVERLAPPING connections
// each expose only their own slice. Seed three integrations A/B/C with one org
// connection apiece; T1 = {A, B}, T2 = {B, C} (B is shared). A session scoped to
// T1 can run A and B but is BLOCKED on C; a session scoped to T2 can run B and C
// but is BLOCKED on A. The shared B never carries the non-shared members across:
// C is reachable under T2 yet blocked under T1, and A is reachable under T1 yet
// blocked under T2 — proving the slices don't leak into one another.
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
// Identifier-safe (no hyphens, lowercase-alphanumeric) so the sandbox
// `tools.<int>.<owner>.<conn>.<tool>` dotted path stays valid JS and the
// connection name survives create-time normalization unchanged.
const ident = (prefix: string): string => `${prefix}${randomBytes(4).toString("hex")}`;

const describeExecute = (defs: ReadonlyArray<{ name: string; description?: string }>): string =>
  defs.find((d) => d.name === "execute")?.description ?? "";

scenario(
  "Toolkits · two toolkits over overlapping connections each see only their own slice; no cross-leak",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      // Stand up a real MCP greeting server per integration -> one org
      // connection each (exposes a `simple_echo` tool discovered at create).
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

      // Three distinct integrations, one org connection each.
      const slugA = ident("tka");
      const slugB = ident("tkb");
      const slugC = ident("tkc");
      const connA = ident("conn");
      const connB = ident("conn");
      const connC = ident("conn");
      yield* addConnection(slugA, connA);
      yield* addConnection(slugB, connB);
      yield* addConnection(slugC, connC);

      // T1 = { A full, B full }; T2 = { B full, C full }. B is shared.
      const t1 = yield* client.toolkits.create({
        payload: {
          slug: ident("kit"),
          name: "Toolkit AB",
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
              access: "full",
            },
          ],
        },
      });
      const t2 = yield* client.toolkits.create({
        payload: {
          slug: ident("kit"),
          name: "Toolkit BC",
          scope: "workspace",
          connections: [
            {
              integration: IntegrationSlug.make(slugB),
              connection: connB,
              access: "full",
            },
            {
              integration: IntegrationSlug.make(slugC),
              connection: connC,
              access: "full",
            },
          ],
        },
      });

      // Address every connection's tool by its dotted sandbox path.
      const callA = `return await tools.${slugA}.org.${connA}.simple_echo({});`;
      const callB = `return await tools.${slugB}.org.${connB}.simple_echo({});`;
      const callC = `return await tools.${slugC}.org.${connC}.simple_echo({});`;

      // ---- Session scoped to T1 (sees A + B, never C) ----
      const s1 = mcp.session(identity, { toolkit: t1.slug });
      const d1 = describeExecute(yield* s1.describeTools());
      expect(d1, "T1 inventory includes A").toContain(slugA);
      expect(d1, "T1 inventory includes B").toContain(slugB);
      expect(d1, "T1 inventory omits C").not.toContain(slugC);

      const s1a = yield* s1.call("execute", { code: callA });
      const s1b = yield* s1.call("execute", { code: callB });
      const s1c = yield* s1.call("execute", { code: callC });
      // In-slice A and B run to the real greeting; out-of-slice C is blocked at
      // execute and surfaces as an error envelope (never the in-slice text).
      expect(s1a.text, `T1·A should run; text=${s1a.text}`).not.toBe("");
      expect(s1b.text, `T1·B should run; text=${s1b.text}`).not.toBe("");
      expect(s1c.text, `T1·C must be blocked; a.text=${s1a.text} c.text=${s1c.text}`).not.toBe(
        s1a.text,
      );
      expect(s1c.text, `T1·C blocked text differs from B; b.text=${s1b.text}`).not.toBe(s1b.text);

      // ---- Session scoped to T2 (sees B + C, never A) ----
      const s2 = mcp.session(identity, { toolkit: t2.slug });
      const d2 = describeExecute(yield* s2.describeTools());
      expect(d2, "T2 inventory includes B").toContain(slugB);
      expect(d2, "T2 inventory includes C").toContain(slugC);
      expect(d2, "T2 inventory omits A").not.toContain(slugA);

      const s2b = yield* s2.call("execute", { code: callB });
      const s2c = yield* s2.call("execute", { code: callC });
      const s2a = yield* s2.call("execute", { code: callA });
      // In-slice B and C run; out-of-slice A is blocked.
      expect(s2b.text, `T2·B should run; text=${s2b.text}`).not.toBe("");
      expect(s2c.text, `T2·C should run; text=${s2c.text}`).not.toBe("");
      expect(s2a.text, `T2·A must be blocked; c.text=${s2c.text} a.text=${s2a.text}`).not.toBe(
        s2c.text,
      );
      expect(s2a.text, `T2·A blocked text differs from B; b.text=${s2b.text}`).not.toBe(s2b.text);

      // ---- The cross term: shared B does not drag its other toolkit's members
      // across. C is reachable under T2 but blocked under T1; A is reachable
      // under T1 but blocked under T2. The two slices stay disjoint on their
      // non-shared members even though both contain B. ----
      expect(d1, "C never appears in T1's inventory (only in T2's)").not.toContain(slugC);
      expect(d2, "A never appears in T2's inventory (only in T1's)").not.toContain(slugA);
      // C's reachable text under T2 is exactly what's denied under T1.
      expect(s2c.text, "C runs under T2 but its T1 attempt was blocked").not.toBe(s1c.text);
      // A's reachable text under T1 is exactly what's denied under T2.
      expect(s1a.text, "A runs under T1 but its T2 attempt was blocked").not.toBe(s2a.text);
    }),
  ),
);
