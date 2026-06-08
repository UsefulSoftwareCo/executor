import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";
import { connectionIdentifier } from "@executor-js/sdk/shared";

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-iso-"));

// Identity comes from request headers so a single handler can serve many
// distinct identities concurrently — the setup that would expose a cross-fiber
// identity leak if the per-request executor's binding were shared rather than
// request-scoped. Each identity is its own (org, user): in v2 the org is the
// tenant (catalog partition) and the user is the acting subject (drives
// `owner: "user"` rows).
const { makeSelfHostTestApp, headerIdentityLayer } = await import("./testing/test-app");

const { handler, dispose } = await makeSelfHostTestApp({
  identity: headerIdentityLayer,
});
afterAll(() => dispose());

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

const headersFor = (userId: string, organizationId: string): Record<string, string> => ({
  "x-test-user": userId,
  "x-test-org": organizationId,
  "content-type": "application/json",
});

const connectionNameForUser = (userId: string): string =>
  String(connectionIdentifier(`conn-${userId}`));

// Seed, as the given identity, a tenant-scoped integration plus a user-owned
// connection named after the subject. Tenant isolation means each identity's
// catalog is independent; subject isolation means the user connection is private.
const seedIdentity = async (userId: string, organizationId: string): Promise<void> => {
  const headers = headersFor(userId, organizationId);
  const add = await handler(
    new Request("http://localhost/api/openapi/specs", {
      method: "POST",
      headers,
      body: JSON.stringify({
        spec: { kind: "blob", value: TINY_SPEC },
        slug: "iso",
        baseUrl: "",
      }),
    }),
  );
  expect(add.status).toBe(200);
  const conn = await handler(
    new Request("http://localhost/api/connections", {
      method: "POST",
      headers,
      body: JSON.stringify({
        owner: "user",
        name: `conn-${userId}`,
        integration: "iso",
        template: "bearer",
        value: `token-${userId}`,
      }),
    }),
  );
  expect(conn.status).toBe(200);
};

const listConnectionAddresses = async (
  userId: string,
  organizationId: string,
): Promise<{ status: number; addresses: string[] }> => {
  const res = await handler(
    new Request("http://localhost/api/connections", {
      headers: { "x-test-user": userId, "x-test-org": organizationId },
    }),
  );
  if (res.status !== 200) return { status: res.status, addresses: [] };
  const body = (await res.json()) as ReadonlyArray<{ address: string }>;
  return { status: res.status, addresses: body.map((c) => c.address) };
};

test("concurrent requests with distinct identities get disjoint, correct executor bindings", async () => {
  // 6 identities, each its own (org, user). Seed each sequentially, then fire 48
  // interleaved reads over the one long-lived SQLite handle.
  const identities = Array.from({ length: 6 }, (_, i) => ({
    userId: `user-${i}`,
    organizationId: `org-${i}`,
  }));

  for (const id of identities) {
    await seedIdentity(id.userId, id.organizationId);
  }

  const requests = Array.from({ length: 48 }, (_, i) => identities[i % identities.length]);
  const results = await Promise.all(
    requests.map((id) => listConnectionAddresses(id.userId, id.organizationId)),
  );

  results.forEach((result, i) => {
    const { userId } = requests[i];
    // Each response reflects ONLY its own request's identity — no bleed. The
    // subject's own user connection is present, and no OTHER subject's is.
    expect(result.status).toBe(200);
    expect(result.addresses.some((a) => a.includes(connectionNameForUser(userId)))).toBe(true);
    const otherUsers = identities.map((id) => id.userId).filter((u) => u !== userId);
    for (const other of otherUsers) {
      expect(result.addresses.some((a) => a.includes(connectionNameForUser(other)))).toBe(false);
    }
  });
}, 15_000);

test("a request with no identity is rejected", async () => {
  const res = await handler(new Request("http://localhost/api/connections"));
  // The header provider returns no principal -> the middleware's unauthenticated
  // path fires.
  expect(res.status).toBeGreaterThanOrEqual(400);
});
