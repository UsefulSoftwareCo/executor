// End-to-end coverage for connection (credential) isolation *through the real
// HTTP API* (v2).
//
// Complements tenant-isolation.node.test.ts (plain cross-org isolation) by
// exercising the owner model the cloud app actually ships: the per-request
// executor binds `{ tenant: organizationId, subject: accountId }`, and every
// connection is filed under `owner: "org"` (tenant-shared) or `owner: "user"`
// (this subject's own). Every request goes through `HttpApiClient` → `fetch` →
// the real `ProtectedCloudApi` → the real Drizzle/FumaDB path.
//
// Invariants the product is staking on:
//
//   1. Users in different orgs can't see each other's org connections.
//   2. Users in the same org can't see each other's user-owned connections
//      (per-user OAuth tokens etc. don't leak to co-workers).
//   3. Org-owned connections ARE visible to every user in that org — an admin
//      writing a shared API key serves the whole tenant.
//   4. The same user id in different orgs is a different tenant binding — a
//      user connection written in org A is invisible in org B.

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  connectionIdentifier,
} from "@executor-js/sdk";
import { makeOpenApiHttpApiTestAddSpecPayload } from "@executor-js/plugin-openapi/testing";

import { asUser } from "./testing/api-harness";

const uniq = () => crypto.randomUUID().slice(0, 8);
const nextOrgId = () => `org_iso_${uniq()}`;
const nextUserId = () => `user_iso_${uniq()}`;

const TEMPLATE_API_KEY = AuthTemplateSlug.make("apiKey");
const canonicalConnectionName = (name: ConnectionName): ConnectionName =>
  connectionIdentifier(String(name));

const PingApi = HttpApi.make("isolationApiTest")
  .add(
    HttpApiGroup.make("default", { topLevel: true }).add(
      HttpApiEndpoint.get("ping", "/ping", { success: Schema.Unknown }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "Isolation API Test", version: "1.0.0" }));

// Registers a minimal openapi integration under `org` (acting as `userId`) so
// connections have an integration to bind to. Returns the slug.
const registerIntegration = (userId: string, org: string) =>
  Effect.gen(function* () {
    const slug = IntegrationSlug.make(`ns_${crypto.randomUUID().replace(/-/g, "_")}`);
    yield* asUser(userId, org, (client) =>
      client.openapi.addSpec({
        payload: makeOpenApiHttpApiTestAddSpecPayload(PingApi, {
          slug,
          baseUrl: "http://example.com",
        }),
      }),
    );
    return slug;
  });

describe("cloud connection isolation (HTTP, owner model)", () => {
  it.effect("users in different orgs cannot read each other's org connections", () =>
    Effect.gen(function* () {
      const orgA = nextOrgId();
      const orgB = nextOrgId();
      const alice = nextUserId();
      const charlie = nextUserId();
      const name = ConnectionName.make(`conn_${uniq()}`);
      const storedName = canonicalConnectionName(name);

      const integrationA = yield* registerIntegration(alice, orgA);
      yield* asUser(alice, orgA, (client) =>
        client.connections.create({
          payload: {
            owner: "org",
            name,
            integration: integrationA,
            template: TEMPLATE_API_KEY,
            value: "alice-org-secret",
          },
        }),
      );

      // Charlie in a different org sees no connections under his (empty) catalog.
      const charlieList = yield* asUser(charlie, orgB, (client) =>
        client.connections.list({ query: {} }),
      );
      expect(charlieList.map((c) => c.name)).not.toContain(storedName);
    }),
  );

  it.effect("users in same org cannot read each other's user-owned connections", () =>
    Effect.gen(function* () {
      const organizationId = nextOrgId();
      const aliceId = nextUserId();
      const bobId = nextUserId();
      const name = ConnectionName.make(`conn_${uniq()}`);
      const storedName = canonicalConnectionName(name);

      const integration = yield* registerIntegration(aliceId, organizationId);

      // Alice writes her personal (`owner: "user"`) connection.
      yield* asUser(aliceId, organizationId, (client) =>
        client.connections.create({
          payload: {
            owner: "user",
            name,
            integration,
            template: TEMPLATE_API_KEY,
            value: "alice-token-value",
          },
        }),
      );

      // Bob is in the same org — his subject differs. He must not see Alice's
      // user connection in a user-owner list.
      const bobUserList = yield* asUser(bobId, organizationId, (client) =>
        client.connections.list({ query: { integration, owner: "user" } }),
      );
      expect(bobUserList.map((c) => c.name)).not.toContain(storedName);

      // And Alice still sees her own connection.
      const aliceUserList = yield* asUser(aliceId, organizationId, (client) =>
        client.connections.list({ query: { integration, owner: "user" } }),
      );
      expect(aliceUserList.map((c) => c.name)).toContain(storedName);
    }),
  );

  it.effect("org-owned connections are visible to every user in that org", () =>
    Effect.gen(function* () {
      const organizationId = nextOrgId();
      const adminId = nextUserId();
      const memberId = nextUserId();
      const name = ConnectionName.make(`conn_${uniq()}`);
      const storedName = canonicalConnectionName(name);

      const integration = yield* registerIntegration(adminId, organizationId);
      yield* asUser(adminId, organizationId, (client) =>
        client.connections.create({
          payload: {
            owner: "org",
            name,
            integration,
            template: TEMPLATE_API_KEY,
            value: "shared-org-key",
          },
        }),
      );

      const adminList = yield* asUser(adminId, organizationId, (client) =>
        client.connections.list({ query: { integration, owner: "org" } }),
      );
      const memberList = yield* asUser(memberId, organizationId, (client) =>
        client.connections.list({ query: { integration, owner: "org" } }),
      );
      expect(adminList.map((c) => c.name)).toContain(storedName);
      expect(memberList.map((c) => c.name)).toContain(storedName);
    }),
  );

  it.effect("same userId in different orgs is a distinct tenant binding", () =>
    Effect.gen(function* () {
      const userId = nextUserId();
      const orgA = nextOrgId();
      const orgB = nextOrgId();
      const name = ConnectionName.make(`conn_${uniq()}`);
      const storedName = canonicalConnectionName(name);

      const integrationA = yield* registerIntegration(userId, orgA);
      yield* asUser(userId, orgA, (client) =>
        client.connections.create({
          payload: {
            owner: "user",
            name,
            integration: integrationA,
            template: TEMPLATE_API_KEY,
            value: "value-in-a",
          },
        }),
      );

      // Same user id, different org → different tenant. Org A's connection (and
      // its integration) must not be visible in org B.
      const listInB = yield* asUser(userId, orgB, (client) =>
        client.connections.list({ query: {} }),
      );
      expect(listInB.map((c) => c.name)).not.toContain(storedName);

      // Sanity: still visible under org A's user-owner list.
      const listInA = yield* asUser(userId, orgA, (client) =>
        client.connections.list({ query: { integration: integrationA, owner: "user" } }),
      );
      expect(listInA.map((c) => c.name)).toContain(storedName);
    }),
  );
});
