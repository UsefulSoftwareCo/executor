// Cloud-only (needs real multi-user organizations): when one member refreshes
// a shared integration's spec, a DIFFERENT member's OWN connection converges to
// the new tool catalog on that member's next read — not just the editor's.
//
// This is the lazy-convergence design. Tools are stored per connection. The
// editor stamps the integration's `config_revised_at`, but the owner policy lets
// them rebuild catalogs only in their own partition — they cannot write a
// co-worker's personal connection rows. So each member's connection carries a
// `tools_synced_at` and rebuilds itself the next time THAT member lists tools.
// Without it, a colleague keeps calling tools that the API no longer serves.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";
import type { Identity, Target as TargetShape } from "../src/target";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

// Same evolving spec the single-user openapi-update-spec scenario uses, so the
// expected tool names below are already an independently-verified contract.
const specV1 = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Evolving API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        summary: "Return a pong",
        responses: { "200": { description: "pong" } },
      },
    },
    "/legacy": {
      get: {
        operationId: "legacyOp",
        summary: "Soon to be removed",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

const specV2 = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Evolving API", version: "2.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        summary: "Return a pong",
        responses: { "200": { description: "pong" } },
      },
    },
    "/widgets": {
      get: {
        operationId: "listWidgets",
        summary: "List widgets",
        responses: { "200": { description: "widgets" } },
      },
    },
  },
});

const V1_TOOLS = ["legacy.legacyOp", "ping.getOperation"];
const V2_TOOLS = ["ping.getOperation", "widgets.listWidgets"];

/** A real 127.0.0.1 server whose served spec can be swapped mid-scenario. */
const serveMutableSpec = (initial: string) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly url: string;
      readonly setBody: (body: string) => void;
      readonly close: () => void;
    }>((resume) => {
      let body = initial;
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}/spec.json`,
            setBody: (next: string) => {
              body = next;
            },
            close: () => {
              server.close();
              server.closeAllConnections();
            },
          }),
        );
      });
    }),
    (server) => Effect.sync(server.close),
  );

// ── Session plumbing over the real auth endpoints (mirrors the web app) ──────
const cookieOf = (identity: Identity): string => identity.headers?.["cookie"] ?? "";

const postJson = (target: TargetShape, path: string, identity: Identity, body: unknown) =>
  Effect.promise(async () => {
    const response = await fetch(new URL(path, target.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: new URL(target.baseUrl).origin,
        cookie: cookieOf(identity),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${path} failed (${response.status}): ${await response.text()}`);
    }
    return response;
  });

const withRefreshedSession = (identity: Identity, response: Response): Identity => {
  const refreshed = (response.headers.getSetCookie?.() ?? [])
    .find((header) => header.startsWith("wos-session="))
    ?.split(";")[0];
  if (!refreshed) throw new Error("response did not refresh the session cookie");
  return { ...identity, headers: { cookie: refreshed } };
};

/** Invite `member` into `admin`'s org and accept — the real invite flow. */
const joinOrg = (target: TargetShape, admin: Identity, member: Identity) =>
  Effect.gen(function* () {
    const inviteResponse = yield* postJson(target, "/api/account/members/invite", admin, {
      email: member.credentials?.email,
    });
    const invitation = (yield* Effect.promise(() => inviteResponse.json())) as { id: string };
    const acceptResponse = yield* postJson(target, "/api/auth/accept-invitation", member, {
      invitationId: invitation.id,
    });
    return withRefreshedSession(member, acceptResponse);
  });

const apiKeyTemplate = [
  {
    slug: "apiKey",
    type: "apiKey" as const,
    headers: { authorization: ["Bearer ", { type: "variable" as const, name: "token" }] },
  },
];

const personalConnection = (client: Client, integration: IntegrationSlug, name: ConnectionName) =>
  client.connections.create({
    payload: {
      owner: "user",
      name,
      integration,
      template: AuthTemplateSlug.make("apiKey"),
      value: `tok-${randomBytes(8).toString("hex")}`,
    },
  });

const ownToolNames = (client: Client, integration: IntegrationSlug) =>
  Effect.map(client.tools.list({ query: { integration, owner: "user" } }), (tools) =>
    tools.map((tool) => tool.name).sort(),
  );

scenario(
  "Convergence · a spec refresh reaches a co-worker's own connection on their next read",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client } = yield* Api;

      const admin = yield* target.newIdentity();
      const invitee = yield* target.newIdentity({ org: false });
      const colleague = yield* joinOrg(target, admin, invitee);

      const adminClient = yield* client(api, admin);
      const colleagueClient = yield* client(api, colleague);

      const slug = IntegrationSlug.make(`converge-${randomBytes(4).toString("hex")}`);
      const adminConn = ConnectionName.make(`admin${randomBytes(3).toString("hex")}`);
      const colleagueConn = ConnectionName.make(`peer${randomBytes(3).toString("hex")}`);
      const specServer = yield* serveMutableSpec(specV1);

      yield* Effect.ensuring(
        Effect.gen(function* () {
          // The admin registers a SHARED (org) integration from the live spec.
          yield* adminClient.openapi.addSpec({
            payload: {
              spec: { kind: "url", url: specServer.url },
              slug,
              baseUrl: "http://127.0.0.1:59999", // tools are never invoked here
              authenticationTemplate: apiKeyTemplate,
            },
          });

          // Each member binds their OWN personal connection to it.
          yield* personalConnection(adminClient, slug, adminConn);
          yield* personalConnection(colleagueClient, slug, colleagueConn);

          // Both see the v1 catalog on their own connection to start.
          expect(yield* ownToolNames(adminClient, slug), "admin starts on v1").toEqual(V1_TOOLS);
          expect(yield* ownToolNames(colleagueClient, slug), "the co-worker starts on v1").toEqual(
            V1_TOOLS,
          );

          // The upstream API ships v2; the admin refreshes the shared spec.
          specServer.setBody(specV2);
          const updated = yield* adminClient.openapi.updateSpec({ params: { slug }, payload: {} });
          expect(updated.addedTools, "the diff names the new tool").toEqual([
            "widgets.listWidgets",
          ]);

          // The editor's own connection follows immediately.
          expect(yield* ownToolNames(adminClient, slug), "admin converged to v2").toEqual(V2_TOOLS);

          // The co-worker did nothing but read — yet their personal connection
          // has converged to v2, even though the admin could never write the
          // co-worker's rows. This is the lazy sync on the colleague's read.
          expect(
            yield* ownToolNames(colleagueClient, slug),
            "the co-worker converged to v2 on their next read",
          ).toEqual(V2_TOOLS);
        }),
        Effect.gen(function* () {
          yield* colleagueClient.connections
            .remove({ params: { owner: "user", integration: slug, name: colleagueConn } })
            .pipe(Effect.ignore);
          yield* adminClient.connections
            .remove({ params: { owner: "user", integration: slug, name: adminConn } })
            .pipe(Effect.ignore);
          yield* adminClient.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
