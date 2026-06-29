// Cloud-only: the connection OWNER model, with real multi-user organizations.
// Every connection is filed under `owner: "org"` (shared with the whole tenant)
// or `owner: "user"` (this subject's own). The org membership is built through
// the real product flows — invite → accept-invitation, create-organization,
// switch-organization — so the guarantees hold for genuine sessions:
//
//   1. A user-owned connection is private to its creator, even from co-workers
//      in the same org (personal OAuth tokens don't leak to colleagues).
//   2. An org-owned connection IS visible to every member of that org — one
//      admin pasting a shared API key serves the whole tenant.
//   3. The same account in two orgs is two separate credential spaces.
import { randomBytes } from "node:crypto";

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
    const slug = IntegrationSlug.make(`owner-scn-${randomBytes(4).toString("hex")}`);
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

// ── Session plumbing over the real auth endpoints ───────────────────────────
// These mirror what the product web app does: cookie-authenticated calls whose
// responses re-seal the session when the active org changes.

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

/** The identity re-bound to the refreshed session cookie a response set. */
const withRefreshedSession = (identity: Identity, response: Response): Identity => {
  const refreshed = (response.headers.getSetCookie?.() ?? [])
    .find((header) => header.startsWith("wos-session="))
    ?.split(";")[0];
  if (!refreshed) throw new Error("response did not refresh the session cookie");
  return { ...identity, headers: { cookie: refreshed } };
};

/** Invite `member` into `admin`'s org and accept — the real invite flow.
 *  Returns the member identity with its session re-bound to that org. */
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

/** Create another org for this account; returns the identity bound to it. */
const createAnotherOrg = (target: TargetShape, identity: Identity, name: string) =>
  Effect.gen(function* () {
    const response = yield* postJson(target, "/api/auth/create-organization", identity, { name });
    return withRefreshedSession(identity, response);
  });

/** Switch this account's active org; returns the identity bound to it. */
const switchOrg = (target: TargetShape, identity: Identity, organizationId: string) =>
  Effect.gen(function* () {
    const response = yield* postJson(target, "/api/auth/switch-organization", identity, {
      organizationId,
    });
    return withRefreshedSession(identity, response);
  });

/** The org this identity's session is currently bound to. */
const activeOrganizationId = (target: TargetShape, identity: Identity) =>
  Effect.promise(async () => {
    const response = await fetch(new URL("/api/auth/me", target.baseUrl), {
      headers: { cookie: cookieOf(identity) },
    });
    if (!response.ok) throw new Error(`/api/auth/me failed (${response.status})`);
    const body = (await response.json()) as { organization: { id: string } | null };
    if (!body.organization) throw new Error("identity has no active organization");
    return body.organization.id;
  });

scenario(
  "Connections · a user-owned connection is private to its creator, even inside the same org",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const admin = yield* target.newIdentity();
    const invitee = yield* target.newIdentity({ org: false });
    const colleague = yield* joinOrg(target, admin, invitee);

    const adminClient = yield* client(api, admin);
    const colleagueClient = yield* client(api, colleague);

    const integration = yield* registerIntegration(adminClient);
    const name = freshConnectionName();
    const secretValue = `personal-token-${randomBytes(8).toString("hex")}`;

    // The admin stores a PERSONAL (user-owned) credential.
    yield* adminClient.connections.create({
      payload: {
        owner: "user",
        name,
        integration,
        template: TEMPLATE_API_KEY,
        value: secretValue,
      },
    });

    // A colleague in the SAME org sees neither the connection nor its bytes.
    const colleagueUserList = yield* colleagueClient.connections.list({
      query: { integration, owner: "user" },
    });
    expect(
      colleagueUserList.map((connection) => connection.name),
      "a co-worker's user-owned list has no trace of the admin's personal connection",
    ).not.toContain(name);

    const colleagueAll = yield* colleagueClient.connections.list({ query: {} });
    expect(
      colleagueAll.map((connection) => connection.name),
      "the personal connection is absent from the co-worker's full list too",
    ).not.toContain(name);
    expect(
      JSON.stringify(colleagueAll),
      "the personal secret appears nowhere in the co-worker's view",
    ).not.toContain(secretValue);

    // And the creator still sees their own connection.
    const adminUserList = yield* adminClient.connections.list({
      query: { integration, owner: "user" },
    });
    expect(
      adminUserList.map((connection) => connection.name),
      "the creator still sees their own personal connection",
    ).toContain(name);
  }),
);

scenario(
  "Connections · an org-owned connection is shared with every member of the org",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const admin = yield* target.newIdentity();
    const invitee = yield* target.newIdentity({ org: false });
    const member = yield* joinOrg(target, admin, invitee);

    const adminClient = yield* client(api, admin);
    const memberClient = yield* client(api, member);

    const integration = yield* registerIntegration(adminClient);
    const name = freshConnectionName();

    // The admin stores a SHARED (org-owned) credential.
    yield* adminClient.connections.create({
      payload: {
        owner: "org",
        name,
        integration,
        template: TEMPLATE_API_KEY,
        value: "shared-org-key",
      },
    });

    const adminOrgList = yield* adminClient.connections.list({
      query: { integration, owner: "org" },
    });
    const memberOrgList = yield* memberClient.connections.list({
      query: { integration, owner: "org" },
    });
    expect(
      adminOrgList.map((connection) => connection.name),
      "the admin sees the shared org connection",
    ).toContain(name);
    expect(
      memberOrgList.map((connection) => connection.name),
      "an invited member sees the shared org connection too",
    ).toContain(name);
  }),
);

scenario(
  "Connections · the same account in two orgs gets two separate credential spaces",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const userInOrgA = yield* target.newIdentity();
    const orgAId = yield* activeOrganizationId(target, userInOrgA);
    const clientA = yield* client(api, userInOrgA);

    const integration = yield* registerIntegration(clientA);
    const name = freshConnectionName();
    yield* clientA.connections.create({
      payload: {
        owner: "user",
        name,
        integration,
        template: TEMPLATE_API_KEY,
        value: "value-in-org-a",
      },
    });

    // The SAME account creates and switches into a second org.
    const userInOrgB = yield* createAnotherOrg(
      target,
      userInOrgA,
      `Second Org ${randomBytes(3).toString("hex")}`,
    );
    const clientB = yield* client(api, userInOrgB);

    const orgBIntegrations = yield* clientB.integrations.list();
    expect(
      orgBIntegrations.map((entry) => entry.slug),
      "the new org does not see org A's integration",
    ).not.toContain(integration);

    const orgBConnections = yield* clientB.connections.list({ query: {} });
    expect(
      orgBConnections.map((connection) => connection.name),
      "the user's org-A connection is invisible from their second org",
    ).not.toContain(name);

    // Switching back to org A, the connection is still theirs.
    const backInOrgA = yield* switchOrg(target, userInOrgB, orgAId);
    const clientABack = yield* client(api, backInOrgA);
    const orgAUserList = yield* clientABack.connections.list({
      query: { integration, owner: "user" },
    });
    expect(
      orgAUserList.map((connection) => connection.name),
      "back in org A, the user-owned connection is still there",
    ).toContain(name);
  }),
);
