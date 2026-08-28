// Cloud-only: the OWNER's view of a workspace — `/api/admin/users*`. The
// product plane answers "what can I, this member, reach"; this plane answers
// "who uses my workspace, and what have they connected", reading across every
// member of the tenant instead of binding to one.
//
// Two members are built through the REAL flows (login → create-organization →
// invite → accept-invitation), each connects their own credential, and the
// admin then reads the joined view — the exact shape a customer dashboard's
// icon grid consumes. The guarantees pinned here:
//
//   1. the joined view reports BOTH members and each one's own connections,
//      even though no single product-view caller can see another member's;
//   2. it never carries credential material;
//   3. a plain member is refused (403) and an anonymous caller too (401);
//   4. another tenant's admin sees none of it.
//
// EMULATOR GAP: the WorkOS emulator hardcodes `owner.type: "user"` in its api-key
// serializer and exposes no organization-key mint route, so an org-scoped API
// key — the machine credential for this plane — cannot exist end-to-end here.
// This scenario therefore drives the ADMIN SESSION path, which is the other
// credential the plane accepts. The org-key half is covered at unit level in
// `apps/cloud/src/auth/org-api-key-mint.node.test.ts` (against the real WorkOS
// response shape) and `org-api-key-auth.node.test.ts` (PlatformAuth resolution).
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { AdminUsersHttpApi } from "@executor-js/api";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";
import { accountIdOf, cookieOf, joinOrg } from "./support/session";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const TEMPLATE_API_KEY = AuthTemplateSlug.make("apiKey");

/** Minimal OpenAPI spec with a single GET /ping — never contacted here. */
const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Ping API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: { operationId: "ping", summary: "Ping", responses: { "200": { description: "pong" } } },
    },
  },
});

/** Registers a fresh apiKey-authenticated integration for connections to bind to. */
const registerIntegration = (client: Client) =>
  Effect.gen(function* () {
    const slug = IntegrationSlug.make(`admin-scn-${randomBytes(4).toString("hex")}`);
    yield* client.openapi.addSpec({
      payload: {
        spec: { kind: "blob", value: pingSpec },
        slug,
        baseUrl: "http://127.0.0.1:59999", // never contacted during registration
        authenticationTemplate: [
          {
            slug: "apiKey",
            type: "apiKey",
            headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
          },
        ],
      },
    });
    return slug;
  });

const freshConnectionName = () => ConnectionName.make(`conn${randomBytes(4).toString("hex")}`);

scenario(
  "Admin · the owner sees every member of the workspace and what each has connected",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: apiClient } = yield* Api;

    const admin = yield* target.newIdentity();
    const invitee = yield* target.newIdentity({ org: false });
    const member = yield* joinOrg(target, admin, invitee);

    const adminClient = yield* apiClient(api, admin);
    const memberClient = yield* apiClient(api, member);
    const adminId = yield* accountIdOf(target, admin);
    const memberId = yield* accountIdOf(target, member);

    const integration = yield* registerIntegration(adminClient);
    const adminConnection = freshConnectionName();
    const memberConnection = freshConnectionName();

    yield* Effect.ensuring(
      Effect.gen(function* () {
        // Each member stores their OWN credential. Neither can see the other's
        // through the product plane — that is the whole point of the admin one.
        yield* adminClient.connections.create({
          payload: {
            owner: "user",
            name: adminConnection,
            integration,
            template: TEMPLATE_API_KEY,
            value: "admin-personal-token",
          },
        });
        yield* memberClient.connections.create({
          payload: {
            owner: "user",
            name: memberConnection,
            integration,
            template: TEMPLATE_API_KEY,
            value: "member-personal-token",
          },
        });

        const client = yield* apiClient(AdminUsersHttpApi, admin);

        // (1) The joined view: both members, each with their own connection.
        const joined = yield* client.adminUsers.listUsersWithConnections({ query: {} });
        const byId = new Map(joined.users.map((user) => [user.externalId, user]));

        expect([...byId.keys()].sort(), "both members of the workspace are reported").toEqual(
          [adminId, memberId].sort(),
        );
        expect(
          byId.get(adminId)?.connections.map((connection) => connection.name),
          "the admin's own connection is attributed to them",
        ).toContain(adminConnection);
        expect(
          byId.get(memberId)?.connections.map((connection) => connection.name),
          "the member's connection is visible to the owner, though not to the admin's product view",
        ).toContain(memberConnection);

        // The host identity join: the WorkOS email lands on the right row.
        //
        // The join key is the membership's `userId` — the same WorkOS `user_...`
        // the subject table records — so this proves the id spaces line up. A
        // mismatch would leave every user unnamed while the id assertions above
        // still passed, which is exactly the failure this asserts against.
        expect(
          byId.get(adminId)?.email,
          "the admin's row carries the email they signed in with",
        ).toBe(admin.credentials?.email);
        expect(byId.get(memberId)?.email, "and the invited member's row carries theirs").toBe(
          member.credentials?.email,
        );

        // The flat list agrees with the joined one.
        const flat = yield* client.adminUsers.listUsers({ query: {} });
        expect(
          flat.users.map((user) => user.externalId).sort(),
          "the flat list reports the same members",
        ).toEqual([adminId, memberId].sort());
        expect(
          flat.users.map((user) => user.email).sort(),
          "with the same identities joined onto it",
        ).toEqual([admin.credentials?.email, member.credentials?.email].sort());

        // Per-user connections resolve the same rows.
        const memberConnections = yield* client.adminUsers.listUserConnections({
          params: { externalId: memberId },
        });
        expect(
          memberConnections.connections.map((connection) => connection.name),
          "the member's connections are readable by external id",
        ).toContain(memberConnection);

        // The single-user read, addressed by EMAIL, against real WorkOS-shaped
        // identity: the reverse directory lookup (email → user id) has to agree
        // with the forward join above, and the answer must carry identity AND
        // connections in the one call a per-user check makes.
        const memberEmail = member.credentials?.email ?? "";
        const single = yield* client.adminUsers.getUser({
          params: { identifier: memberEmail },
        });
        expect(single.user.externalId, "the email resolves to the same member").toBe(memberId);
        expect(single.user.email, "and carries the identity the list reported").toBe(memberEmail);
        expect(
          single.user.connections.map((connection) => connection.name),
          "with their connections joined in the same response",
        ).toContain(memberConnection);

        // The same read by opaque id agrees, so neither identifier is a
        // different code path with a different answer.
        const byOpaqueId = yield* client.adminUsers.getUser({
          params: { identifier: memberId },
        });
        expect(byOpaqueId.user.email).toBe(memberEmail);
        expect(byOpaqueId.user.connections.map((connection) => connection.name)).toEqual(
          single.user.connections.map((connection) => connection.name),
        );

        // The bulk filter selects the same member out of the workspace.
        const filtered = yield* client.adminUsers.listUsers({
          query: { email: memberEmail },
        });
        expect(
          filtered.users.map((user) => user.externalId),
          "?email= narrows the list to exactly that member",
        ).toEqual([memberId]);

        // (2) No credential material anywhere in the joined view.
        expect(
          JSON.stringify(joined),
          "the admin view never carries a stored credential",
        ).not.toContain("member-personal-token");
        expect(JSON.stringify(joined)).not.toContain("admin-personal-token");

        // (3) A plain member is refused: this plane reports on everyone.
        const asMember = yield* Effect.promise(() =>
          fetch(new URL("/api/admin/users", target.baseUrl), {
            headers: { cookie: cookieOf(member) },
          }),
        );
        expect(asMember.status, "a non-admin member cannot read the workspace view").toBe(403);

        // And an anonymous caller has no credential at all.
        const anonymous = yield* Effect.promise(() =>
          fetch(new URL("/api/admin/users", target.baseUrl)),
        );
        expect(anonymous.status, "no session → unauthorized").toBe(401);
      }),
      Effect.all(
        [
          adminClient.connections
            .remove({ params: { owner: "user", integration, name: adminConnection } })
            .pipe(Effect.ignore),
          memberClient.connections
            .remove({ params: { owner: "user", integration, name: memberConnection } })
            .pipe(Effect.ignore),
          adminClient.openapi.removeSpec({ params: { slug: integration } }).pipe(Effect.ignore),
        ],
        { discard: true },
      ),
    );
  }),
);

scenario(
  "Admin · one workspace's owner sees nothing of another workspace",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: apiClient } = yield* Api;

    const mine = yield* target.newIdentity();
    const theirs = yield* target.newIdentity();
    const myId = yield* accountIdOf(target, mine);
    const theirId = yield* accountIdOf(target, theirs);

    const myClient = yield* apiClient(api, mine);
    // A user earns their row in the workspace the first time they touch the
    // EXECUTOR plane (the account plane doesn't bind an executor), so the other
    // owner makes one product read — otherwise their own workspace is empty and
    // the isolation assertion below would pass vacuously.
    yield* (yield* apiClient(api, theirs)).connections.list({ query: {} });
    const integration = yield* registerIntegration(myClient);
    const connection = freshConnectionName();

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* myClient.connections.create({
          payload: {
            owner: "user",
            name: connection,
            integration,
            template: TEMPLATE_API_KEY,
            value: "my-private-token",
          },
        });

        const theirAdmin = yield* apiClient(AdminUsersHttpApi, theirs);
        const theirView = yield* theirAdmin.adminUsers.listUsersWithConnections({ query: {} });

        expect(
          theirView.users.map((user) => user.externalId),
          "another workspace's owner never sees my members",
        ).not.toContain(myId);
        expect(
          theirView.users.map((user) => user.externalId),
          "they do see their own",
        ).toContain(theirId);
        expect(
          JSON.stringify(theirView),
          "and none of my connections leak across the tenant boundary",
        ).not.toContain(connection);

        // Naming my account id directly returns nothing rather than my rows.
        const probe = yield* theirAdmin.adminUsers.listUserConnections({
          params: { externalId: myId },
        });
        expect(probe.connections, "a cross-tenant id resolves to nothing").toEqual([]);

        // And the single-user read refuses to confirm I exist at all — by my
        // id or by my email, both of which are real, just not theirs.
        for (const identifier of [myId, mine.credentials?.email ?? ""]) {
          const response = yield* Effect.promise(() =>
            fetch(new URL(`/api/admin/users/${encodeURIComponent(identifier)}`, target.baseUrl), {
              headers: { cookie: cookieOf(theirs) },
            }),
          );
          expect(response.status, "a cross-tenant lookup is a plain 404, revealing nothing").toBe(
            404,
          );
        }
      }),
      Effect.all(
        [
          myClient.connections
            .remove({ params: { owner: "user", integration, name: connection } })
            .pipe(Effect.ignore),
          myClient.openapi.removeSpec({ params: { slug: integration } }).pipe(Effect.ignore),
        ],
        { discard: true },
      ),
    );
  }),
);
