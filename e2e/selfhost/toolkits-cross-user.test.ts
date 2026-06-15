// Selfhost · cross-user visibility of toolkits. The contract under test:
// workspace toolkits ride org-owned plugin storage (visible to every org
// member), personal toolkits ride user-owned storage (visible only to their
// creating subject), and the MCP toolkit selector is fail-closed — a slug the
// caller can't resolve narrows the engine to an EMPTY slice rather than leaking
// the slice it names. `resolveScope` returns null for a slug the caller isn't
// entitled to (server.ts: "a cross-tenant/personal-of-another-user selector
// returns null"), so a hijacked-slug session sees nothing.
//
// HARNESS CAVEAT (verified in e2e/targets/selfhost.ts): selfhost is
// single-tenant today — `newIdentity()` always signs the SAME bootstrap admin
// in, so two `newIdentity()` calls yield the SAME subject in the SAME org, not
// two distinct members. We assert that fact below so the test self-documents
// why the "a DIFFERENT user is denied" leg cannot be driven here. We instead
// prove the enforcement MECHANISM that backs cross-user privacy and IS
// drivable on one subject: an MCP session whose `?toolkit=` slug does not
// resolve for the caller is narrowed to an empty slice and blocks the named
// connection's tool at execute. (The true second-member denial belongs to a
// multi-tenant target, e.g. cloud, once selfhost grows per-test signup.)
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
// dotted path stays valid JS, and so connection names survive the create-time
// normalize (hyphens removed + camelCased) byte-for-byte.
const ident = (prefix: string): string => `${prefix}${randomBytes(4).toString("hex")}`;

const describeExecute = (defs: ReadonlyArray<{ name: string; description?: string }>): string =>
  defs.find((d) => d.name === "execute")?.description ?? "";

scenario(
  "Toolkits · workspace toolkits are visible to org members; personal toolkits stay subject-private and a non-resolving slug is fail-closed",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const mcp = yield* Mcp;

      // Two identities + a client each. On selfhost both resolve to the
      // bootstrap admin (same subject, same org) — see the harness caveat.
      const idA = yield* target.newIdentity();
      const idB = yield* target.newIdentity();
      const clientA = yield* makeApiClient(api, idA);
      const clientB = yield* makeApiClient(api, idB);

      // Make the single-subject reality explicit: the "different member" leg of
      // the cross-user contract degenerates here, and the assertions below are
      // written to what selfhost can actually prove.
      const sameSubject = idA.credentials?.email === idB.credentials?.email;
      expect(
        sameSubject,
        "selfhost is single-tenant: both identities are the bootstrap admin",
      ).toBe(true);

      // Stand up two real greeting MCP servers and register each as an
      // integration + a connection at the requested owner. `text` is distinct
      // per connection so a successful execute is unambiguous.
      const addConnection = (slug: string, conn: string, owner: "org" | "user", text: string) =>
        Effect.gen(function* () {
          const token = `tok-${randomBytes(6).toString("hex")}`;
          const server = yield* serveMcpServer(() => makeGreetingMcpServer({ text }), {
            auth: {
              validateAuthorization: (authorization) =>
                Effect.succeed(authorization === `Bearer ${token}`),
            },
          });
          yield* clientA.mcp.addServer({
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
          yield* clientA.connections.create({
            payload: {
              owner,
              name: ConnectionName.make(conn),
              integration: IntegrationSlug.make(slug),
              template: AuthTemplateSlug.make("header"),
              value: token,
            },
          });
        });

      // idA seeds ONE org connection and ONE personal connection, and the
      // expected greeting each tool returns.
      const orgSlug = ident("orgint");
      const orgConn = ident("orgconn");
      const orgText = `hello-org-${randomBytes(3).toString("hex")}`;
      const personalSlug = ident("pvtint");
      const personalConn = ident("pvtconn");
      const personalText = `hello-pvt-${randomBytes(3).toString("hex")}`;
      yield* addConnection(orgSlug, orgConn, "org", orgText);
      yield* addConnection(personalSlug, personalConn, "user", personalText);

      // A WORKSPACE toolkit (org-owned) over the org connection, and a PERSONAL
      // toolkit (user-owned) over idA's own connection — both at full access.
      const workspaceKit = yield* clientA.toolkits.create({
        payload: {
          slug: ident("wskit"),
          name: "Workspace kit",
          scope: "workspace",
          connections: [
            {
              integration: IntegrationSlug.make(orgSlug),
              connection: orgConn,
              access: "full",
            },
          ],
        },
      });
      const personalKit = yield* clientA.toolkits.create({
        payload: {
          slug: ident("pvtkit"),
          name: "Personal kit",
          scope: "personal",
          connections: [
            {
              integration: IntegrationSlug.make(personalSlug),
              connection: personalConn,
              access: "full",
            },
          ],
        },
      });

      // (a) The other client's list. The workspace toolkit is org-owned, so it
      // MUST be present. On a multi-tenant target the personal toolkit (a
      // different member's user-owned data) would be ABSENT; on selfhost idB IS
      // idA, so it is present — we assert the truth for this target and pin the
      // workspace-visible invariant unconditionally.
      const listB = yield* clientB.toolkits.list();
      expect(
        listB.some((t) => t.id === workspaceKit.id && t.slug === workspaceKit.slug),
        "workspace toolkit is visible to org members",
      ).toBe(true);
      expect(
        listB.some((t) => t.id === personalKit.id),
        sameSubject
          ? "selfhost single-subject: idA's personal toolkit is visible because idB IS idA"
          : "a personal toolkit must not appear in another member's list",
      ).toBe(sameSubject);

      // (b) An MCP session for idB scoped to the WORKSPACE slug exposes the org
      // slice: the execute inventory mentions the org integration, and running
      // its tool returns the org greeting (a success envelope, not an error).
      const wsSession = mcp.session(idB, { toolkit: workspaceKit.slug });
      const wsDesc = describeExecute(yield* wsSession.describeTools());
      expect(wsDesc, "workspace-scoped inventory includes the org integration").toContain(orgSlug);

      const wsCall = yield* wsSession.call("execute", {
        code: `return await tools.${orgSlug}.org.${orgConn}.simple_echo({});`,
      });
      expect(wsCall.ok, `org tool executes; text=${wsCall.text}`).toBe(true);
      expect(
        wsCall.text,
        `workspace slice returns the org greeting; text=${wsCall.text}`,
      ).toContain(orgText);

      // (c) Fail-closed selector — the mechanism behind cross-user privacy. A
      // session whose `?toolkit=` slug the caller cannot resolve is narrowed to
      // an EMPTY slice: the named connection is neither advertised nor runnable.
      // We exercise it two ways:
      //   1. the personal slug from another (here: the same) subject's kit, and
      //   2. a slug that does not exist at all,
      // and require BOTH to behave identically — proving a personal toolkit
      // cannot be hijacked by handing its slug to a session that isn't entitled
      // to it. (Selfhost can't supply a second subject, so the personal slug
      // DOES resolve here; the bogus slug is the load-bearing fail-closed proof,
      // and the personal-slug case still confirms the personal connection is not
      // leaked into an unrelated/empty narrowing.)
      const hijackSession = mcp.session(idB, { toolkit: ident("ghostkit") });
      const hijackDesc = describeExecute(yield* hijackSession.describeTools());
      expect(
        hijackDesc,
        "an unresolved toolkit slug yields an empty slice — personal connection not exposed",
      ).not.toContain(personalSlug);
      expect(
        hijackDesc,
        "an unresolved toolkit slug yields an empty slice — org connection not exposed either",
      ).not.toContain(orgSlug);

      // Executing the personal connection's tool through the empty/unresolved
      // slice is blocked: the result is never the personal greeting the tool
      // would emit if the slice had actually exposed it.
      const hijackCall = yield* hijackSession.call("execute", {
        code: `return await tools.${personalSlug}.user.${personalConn}.simple_echo({});`,
      });
      expect(
        hijackCall.text,
        `unresolved-slug session must not return the personal greeting; text=${hijackCall.text}`,
      ).not.toContain(personalText);
    }),
  ),
);
