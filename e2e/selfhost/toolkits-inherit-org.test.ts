// Selfhost · org policies vs a toolkit's inheritOrgPolicies flag.
//
// Org `block` / `require_approval` guardrails always reach scoped sessions; only
// org `approve` rows may be dropped when inheritOrgPolicies=false.
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

// The composed API carries the toolkits group, the MCP-server-management group,
// AND the core PoliciesApi (included by composePluginApi), so `client.policies.*`
// and `client.toolkits.*` are both typed here.
const api = composePluginApi([mcpHttpPlugin(), toolkitsPlugin()] as const);

// Identifier-safe (no hyphens) so the sandbox `tools.<int>.<owner>.<conn>.<tool>`
// dotted path stays a valid JS member expression and names normalize cleanly.
const ident = (prefix: string): string => `${prefix}${randomBytes(4).toString("hex")}`;

const describeExecute = (defs: ReadonlyArray<{ name: string; description?: string }>): string =>
  defs.find((d) => d.name === "execute")?.description ?? "";

// A `block` surfaces as an error envelope at execute: `.ok` true, the error
// (tool_blocked) inside `.text`. A successful greeting never contains this.
const isBlocked = (text: string): boolean => text.includes("tool_blocked");

scenario(
  "Toolkits · an org block policy is enforced via the base executor and reaches a toolkit slice",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      // One real greeting MCP server -> one integration + an org connection that
      // exposes a `simple_echo` tool (discovered at connection create).
      const slug = ident("inh");
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

      const code = `return await tools.${slug}.org.${conn}.simple_echo({});`;

      // Without any org policy, a bare /mcp session runs the tool — the baseline
      // "this connection works" before the org guardrail is in place.
      const beforePolicy = yield* mcp.session(identity).call("execute", { code });
      expect(
        beforePolicy.ok && !isBlocked(beforePolicy.text),
        `connection works before the org policy; text=${beforePolicy.text}`,
      ).toBe(true);

      // ORG-LEVEL block policy over the connection's tool. The org `tool_policy`
      // matcher tests the 4-segment `<integration>.<owner>.<connection>.<tool>`
      // address, so `<slug>.*` (a trailing-`*` subtree) blocks
      // `<slug>.org.<conn>.simple_echo` for this org outside any toolkit.
      const orgPattern = `${slug}.*`;
      const orgPolicy = yield* client.policies.create({
        payload: { owner: "org", pattern: orgPattern, action: "block" },
      });
      expect(orgPolicy.owner, "the org policy is owned by the org").toBe("org");
      expect(orgPolicy.action, "the org policy blocks").toBe("block");
      expect(orgPolicy.pattern, "the org policy targets the connection's tool").toBe(orgPattern);

      // The org block is real: the bare session (no toolkit) is now blocked.
      const bareCall = yield* mcp.session(identity).call("execute", { code });
      expect(
        isBlocked(bareCall.text),
        `org block applies to the bare session; before=${beforePolicy.text} after=${bareCall.text}`,
      ).toBe(true);

      // Two workspace toolkits over the SAME connection, both at full access,
      // differing ONLY in inheritOrgPolicies.
      const inherit = yield* client.toolkits.create({
        payload: {
          slug: ident("kitinh"),
          name: "Inherits org",
          scope: "workspace",
          inheritOrgPolicies: true,
          connections: [
            {
              integration: IntegrationSlug.make(slug),
              connection: conn,
              access: "full",
            },
          ],
        },
      });
      expect(inherit.inheritOrgPolicies, "T_inherit flag round-trips as true").toBe(true);

      const isolated = yield* client.toolkits.create({
        payload: {
          slug: ident("kitiso"),
          name: "Isolated",
          scope: "workspace",
          inheritOrgPolicies: false,
          connections: [
            {
              integration: IntegrationSlug.make(slug),
              connection: conn,
              access: "full",
            },
          ],
        },
      });
      expect(isolated.inheritOrgPolicies, "T_isolated flag round-trips as false").toBe(false);

      // Both slices grant the connection at full, so neither hides it for lack of
      // access — any block is the org policy reaching the slice, not the grant.
      const inheritDesc = describeExecute(
        yield* mcp.session(identity, { toolkit: inherit.slug }).describeTools(),
      );
      const isolatedDesc = describeExecute(
        yield* mcp.session(identity, { toolkit: isolated.slug }).describeTools(),
      );
      expect(inheritDesc, "T_inherit slice scopes to the integration").toContain(slug);
      expect(isolatedDesc, "T_isolated slice scopes to the integration").toContain(slug);

      // Execute the SAME code in each scoped session.
      const inheritCall = yield* mcp
        .session(identity, { toolkit: inherit.slug })
        .call("execute", { code });
      const isolatedCall = yield* mcp
        .session(identity, { toolkit: isolated.slug })
        .call("execute", { code });

      // T_inherit inherits the org block (the intended contract for true): blocked.
      expect(
        isBlocked(inheritCall.text),
        `T_inherit (inheritOrgPolicies:true) inherits the org block; text=${inheritCall.text}`,
      ).toBe(true);

      // T_isolated still inherits org block/require_approval guardrails even when
      // inheritOrgPolicies:false — a toolkit may only tighten, never loosen.
      expect(
        isBlocked(isolatedCall.text),
        `T_isolated (inheritOrgPolicies:false) still blocked by org guardrail; text=${isolatedCall.text}`,
      ).toBe(true);
      const inheritView = yield* client.toolkits.get({
        params: { id: inherit.id },
      });
      const isolatedView = yield* client.toolkits.get({
        params: { id: isolated.id },
      });
      expect(inheritView.inheritOrgPolicies, "view preserves true").toBe(true);
      expect(isolatedView.inheritOrgPolicies, "view preserves false").toBe(false);
    }),
  ),
);
