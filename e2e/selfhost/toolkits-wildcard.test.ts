// Selfhost · Toolkits wildcard ("*") tracks every account of an integration,
// including accounts added AFTER the toolkit is created. A toolkit entry whose
// `connection` is "*" is integration-level: the MCP narrowing seam
// (toolkit-scope.ts `accessFor`) matches ANY connection of that integration,
// and `resolveScope` re-reads the live connection set per session — so a fresh
// scoped session opened after a new account is added auto-includes it, while a
// session's slice is fixed to the integration, never leaking a sibling
// integration's accounts.
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
// dotted path stays valid JS, and single-word lowercase names survive the
// connectionIdentifier normalization unchanged.
const ident = (prefix: string): string => `${prefix}${randomBytes(4).toString("hex")}`;

const describeExecute = (defs: ReadonlyArray<{ name: string; description?: string }>): string =>
  defs.find((d) => d.name === "execute")?.description ?? "";

scenario(
  'Toolkits · a wildcard ("*") entry tracks every account of an integration, including ones added after the toolkit',
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      // Register an integration ONCE via addServer, then add accounts to it with
      // repeated connections.create calls (same integration slug, new name).
      // addServer creates/updates the integration + auth template; each
      // connections.create adds one account (org-owned connection) under it.
      const addIntegration = (slug: string) =>
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
          // Each account points at the same integration's greeting server; the
          // token satisfies that integration's auth template.
          const addAccount = (conn: string) =>
            client.connections.create({
              payload: {
                owner: "org",
                name: ConnectionName.make(conn),
                integration: IntegrationSlug.make(slug),
                template: AuthTemplateSlug.make("header"),
                value: token,
              },
            });
          return { addAccount };
        });

      const slugX = ident("tkx");
      const { addAccount: addX } = yield* addIntegration(slugX);

      // Integration X starts with TWO org accounts.
      const primary = ident("primary");
      const secondary = ident("secondary");
      yield* addX(primary);
      yield* addX(secondary);

      // An UNRELATED integration Y with its own account — the wildcard must NOT
      // reach it (the entry is scoped to X only).
      const slugY = ident("tky");
      const { addAccount: addY } = yield* addIntegration(slugY);
      const connY = ident("other");
      yield* addY(connY);

      // A workspace toolkit with a SINGLE integration-level entry: every account
      // of X, full access. Y is never named, so it is out of slice.
      const kit = yield* client.toolkits.create({
        payload: {
          slug: ident("kit"),
          name: "Wildcard kit",
          scope: "workspace",
          connections: [
            {
              integration: IntegrationSlug.make(slugX),
              connection: "*",
              access: "full",
            },
          ],
        },
      });

      // Session #1: both pre-existing accounts are in the slice; Y is not.
      const session1 = mcp.session(identity, { toolkit: kit.slug });
      const desc1 = describeExecute(yield* session1.describeTools());
      expect(desc1, "wildcard slice includes the primary account").toContain(primary);
      expect(desc1, "wildcard slice includes the secondary account").toContain(secondary);
      expect(desc1, "wildcard is scoped to X — Y's account is out of slice").not.toContain(connY);

      const primaryRun = yield* session1.call("execute", {
        code: `return await tools.${slugX}.org.${primary}.simple_echo({});`,
      });
      expect(primaryRun.ok, `primary account runs; text=${primaryRun.text}`).toBe(true);

      const secondaryRun = yield* session1.call("execute", {
        code: `return await tools.${slugX}.org.${secondary}.simple_echo({});`,
      });
      expect(secondaryRun.ok, `secondary account runs; text=${secondaryRun.text}`).toBe(true);

      // Y is blocked at execute even though the agent guessed its address — a
      // blocked tool surfaces as an error envelope, never the greeting a
      // legitimate account returns.
      const yRun = yield* session1.call("execute", {
        code: `return await tools.${slugY}.org.${connY}.simple_echo({});`,
      });
      expect(
        yRun.text,
        `out-of-slice Y must be blocked; primary.text=${primaryRun.text} y.ok=${yRun.ok} y.text=${yRun.text}`,
      ).not.toBe(primaryRun.text);

      // --- The auto-update assertion ----------------------------------------
      // Add a THIRD account to X AFTER the toolkit was created. The toolkit is
      // untouched (still a single "*" entry).
      const tertiary = ident("tertiary");
      yield* addX(tertiary);

      // A NEW scoped session re-resolves the slice, so the wildcard now also
      // covers the just-added account. (Session #1 keeps its original snapshot —
      // we deliberately open a fresh session here.)
      const session2 = mcp.session(identity, { toolkit: kit.slug });
      const desc2 = describeExecute(yield* session2.describeTools());
      expect(desc2, "a fresh session's wildcard still includes primary").toContain(primary);
      expect(desc2, "a fresh session's wildcard still includes secondary").toContain(secondary);
      expect(desc2, "the wildcard auto-includes the account added after the toolkit").toContain(
        tertiary,
      );

      const tertiaryRun = yield* session2.call("execute", {
        code: `return await tools.${slugX}.org.${tertiary}.simple_echo({});`,
      });
      expect(
        tertiaryRun.ok,
        `the later-added account runs in a fresh scoped session; text=${tertiaryRun.text}`,
      ).toBe(true);
    }),
  ),
);
