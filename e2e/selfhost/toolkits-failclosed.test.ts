// Selfhost · Toolkits fail-closed. SECURITY-CRITICAL: an unknown/invalid
// ?toolkit= selector must FAIL CLOSED — the engine narrows to an EMPTY slice
// (EMPTY_TOOLKIT_SCOPE, applied by narrowToToolkit when resolveScope returns
// null) where every connection tool is blocked — and must NEVER silently fall
// back to full (unscoped) account access.
//
// The control is a BARE session (no selector): the real org connection's tool
// RUNS and its result text is the real greeting. The probe is a session scoped
// to a bogus selector ("doesnotexist"+hex): the SAME real tool is blocked at
// execute (error envelope, not the real greeting) and the bogus inventory lists
// no connections. A regression where a bad selector granted full access would
// make the bogus execute return the real greeting (== the bare execute) and the
// bogus inventory contain the connection's integration — both asserted against.
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
// dotted path stays valid JS, and names survive create normalization.
const ident = (prefix: string): string => `${prefix}${randomBytes(4).toString("hex")}`;

const describeExecute = (defs: ReadonlyArray<{ name: string; description?: string }>): string =>
  defs.find((d) => d.name === "execute")?.description ?? "";

scenario(
  "Toolkits · a bogus toolkit selector fails closed — empty slice, never full access",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      // Seed ONE real org connection (a greeting MCP server -> integration +
      // org connection exposing a `simple_echo` tool discovered at create).
      const slug = ident("tk");
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

      // A real WORKSPACE toolkit referencing the connection — proves the account
      // genuinely has both runnable tools and a real toolkit, so the only thing
      // distinguishing the probe is its bogus selector.
      yield* client.toolkits.create({
        payload: {
          slug: ident("kit"),
          name: "Real kit",
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

      const code = `return await tools.${slug}.org.${conn}.simple_echo({});`;

      // (a) CONTROL — bare session (no selector): the tool RUNS and the
      // inventory lists the connection's integration.
      const bare = mcp.session(identity);
      const bareDesc = describeExecute(yield* bare.describeTools());
      expect(bareDesc, "bare inventory includes the seeded integration").toContain(slug);
      const bareRun = yield* bare.call("execute", { code });
      expect(bareRun.ok, `bare tool executes; text=${bareRun.text}`).toBe(true);

      // (b) PROBE — session scoped to a selector that resolves to no toolkit.
      // Inventory must list NO connections (only static/core tools survive an
      // empty slice), and the SAME tool must be BLOCKED at execute.
      const bogusSelector = ident("doesnotexist");
      const bogus = mcp.session(identity, { toolkit: bogusSelector });
      const bogusDesc = describeExecute(yield* bogus.describeTools());
      const bogusRun = yield* bogus.call("execute", { code });

      // (c) STRENGTHEN — unambiguous fail-closed assertions. A regression where
      // the bogus selector granted full access would fail every one of these:
      //   - the bogus inventory would contain the integration slug, and
      //   - the bogus execute would return the SAME real greeting as the bare run.
      expect(
        bogusDesc,
        `bogus selector must NOT leak the seeded integration into inventory; bogusDesc=${bogusDesc}`,
      ).not.toContain(slug);
      // Blocked execute surfaces as an error envelope (.text differs) — never the
      // real greeting the bare control returns. We compare .text, not .ok.
      expect(
        bogusRun.text,
        `bogus selector must BLOCK the tool, not return the real result; bare.text=${bareRun.text} bogus.ok=${bogusRun.ok} bogus.text=${bogusRun.text}`,
      ).not.toBe(bareRun.text);
    }),
  ),
);
