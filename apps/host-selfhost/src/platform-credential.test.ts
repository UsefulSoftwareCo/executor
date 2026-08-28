import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test } from "@effect/vitest";

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-platform-"));

// ---------------------------------------------------------------------------
// The shared middleware's PLATFORM branch, end-to-end over the real router: an
// org-level credential (the shape cloud's org-scoped API key resolves to) gets
// tenant-level READS on the ordinary product paths, and nothing else.
//
// Served through the self-host test app because it runs the SAME
// `makeExecutionStackMiddleware` cloud's protected plane uses — the branch
// under test is host-neutral, and this is the harness that can drive it
// without WorkOS. The `x-test-platform-org` header resolves the platform
// principal (see testing/test-app.ts).
//
// Pinned here:
//   1. GET /api/integrations answers the tenant catalog — the read that used
//      to require a second, member credential (the customer-reported gap);
//   2. GET /api/connections answers org-owned rows WITHOUT any member's
//      personal connections (bound reach, no subject);
//   3. any non-GET is refused 403 before a handler runs;
//   4. the credential mints NO subject row — an org key must never appear as a
//      user of the workspace it observes.
// ---------------------------------------------------------------------------

let handler!: (request: Request) => Promise<Response>;
let dispose: () => Promise<void> = async () => {};

beforeAll(async () => {
  const { makeSelfHostTestApp, headerIdentityLayer } = await import("./testing/test-app");
  const app = await makeSelfHostTestApp({
    identity: headerIdentityLayer,
  });
  handler = app.handler;
  dispose = app.dispose;
});
afterAll(() => dispose());

const ORG = "platform-org";
const MEMBER = "member-user";

const TINY_SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Tiny", version: "1.0.0" },
  servers: [{ url: "https://httpbin.org" }],
  paths: {
    "/get": {
      get: {
        operationId: "httpGet",
        summary: "GET",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

const memberHeaders: Record<string, string> = {
  "x-test-user": MEMBER,
  "x-test-org": ORG,
  "content-type": "application/json",
};

const platformHeaders: Record<string, string> = {
  "x-test-platform-org": ORG,
  "content-type": "application/json",
};

/** Seed as the MEMBER: a catalog row, an org-owned connection, and a personal
 *  one — so the platform reads below have both a hit and a must-miss. */
beforeAll(async () => {
  const add = await handler(
    new Request("http://localhost/api/openapi/specs", {
      method: "POST",
      headers: memberHeaders,
      body: JSON.stringify({ spec: { kind: "blob", value: TINY_SPEC }, slug: "cat", baseUrl: "" }),
    }),
  );
  expect(add.status).toBe(200);
  const orgConn = await handler(
    new Request("http://localhost/api/connections", {
      method: "POST",
      headers: memberHeaders,
      body: JSON.stringify({
        owner: "org",
        name: "shared",
        integration: "cat",
        template: "bearer",
        value: "org-shared-token",
      }),
    }),
  );
  expect(orgConn.status).toBe(200);
  const userConn = await handler(
    new Request("http://localhost/api/connections", {
      method: "POST",
      headers: memberHeaders,
      body: JSON.stringify({
        owner: "user",
        name: "personal",
        integration: "cat",
        template: "bearer",
        value: "member-personal-token",
      }),
    }),
  );
  expect(userConn.status).toBe(200);
});

test("a platform credential reads the tenant catalog on the ordinary product path", async () => {
  const res = await handler(
    new Request("http://localhost/api/integrations", { headers: platformHeaders }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as ReadonlyArray<{ readonly slug: string }>;
  expect(
    body.map((integration) => integration.slug),
    "the catalog the member configured is readable with the org credential alone",
  ).toContain("cat");
});

test("connection reads answer org-owned rows and never a member's personal ones", async () => {
  const res = await handler(
    new Request("http://localhost/api/connections", { headers: platformHeaders }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as ReadonlyArray<{ readonly name: string }>;
  const raw = JSON.stringify(body);
  expect(
    body.map((connection) => connection.name),
    "the org-owned connection is visible",
  ).toContain("shared");
  expect(
    body.map((connection) => connection.name),
    "a member's personal connection is not — the platform view binds no subject",
  ).not.toContain("personal");
  expect(raw, "no credential material either way").not.toContain("token");
});

test("the OAuth callback is refused despite being a GET", async () => {
  // The one core GET with side effects: completing it would burn an org-owned
  // in-flight authorization code in an outbound token exchange before the
  // storage policy could refuse the final write. The safe-request gate excludes
  // it by name; a platform credential landing here is a clear 403, not a
  // half-executed flow.
  const res = await handler(
    new Request("http://localhost/api/oauth/callback?code=x&state=y", {
      headers: platformHeaders,
    }),
  );
  expect(res.status, "the callback is not a safe read").toBe(403);
  expect(await res.text()).toContain("read-only");
});

test("every non-GET is refused before a handler runs", async () => {
  const post = await handler(
    new Request("http://localhost/api/connections", {
      method: "POST",
      headers: platformHeaders,
      body: JSON.stringify({
        owner: "org",
        name: "sneaky",
        integration: "cat",
        template: "bearer",
        value: "nope",
      }),
    }),
  );
  expect(post.status, "a write with a read-only credential is a clear 403").toBe(403);
  expect(await post.text()).toContain("read-only");

  const del = await handler(
    new Request("http://localhost/api/integrations/cat", {
      method: "DELETE",
      headers: platformHeaders,
    }),
  );
  expect(del.status).toBe(403);

  // The refusal happened before any handler: the connection it tried to write
  // does not exist.
  const after = await handler(
    new Request("http://localhost/api/connections", { headers: platformHeaders }),
  );
  const names = ((await after.json()) as ReadonlyArray<{ readonly name: string }>).map(
    (connection) => connection.name,
  );
  expect(names).not.toContain("sneaky");
});

test("the credential never mints a subject row in the workspace it observes", async () => {
  // Several platform reads have run by now. If any of them touched the subject
  // table, the org would report a phantom user; only the seeding member may
  // appear.
  const { withQueryContext } = await import("@executor-js/fumadb/query");
  const { createSelfHostDb } = await import("./db/self-host-db");
  const { loadConfig } = await import("./config");
  const db = await createSelfHostDb({ path: loadConfig().dbPath });
  const rows = await withQueryContext(db.db, { tenant: ORG, subject: null }).findMany("subject", {
    orderBy: ["external_id", "asc"],
  });
  await db.close();
  expect(
    rows.map((row) => String(row.external_id)),
    "only the member has a footprint",
  ).toEqual([MEMBER]);
});
