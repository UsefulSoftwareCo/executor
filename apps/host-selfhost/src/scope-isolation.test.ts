import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-iso-"));

// Identity comes from request headers so a single handler can serve many
// distinct identities concurrently — the setup that would expose a
// cross-fiber scope leak if the executor's scope were shared rather than
// request-scoped.
const { makeSelfHostTestApp, headerIdentityLayer } = await import("./testing/test-app");

const { handler, dispose } = await makeSelfHostTestApp({ identity: headerIdentityLayer });
afterAll(() => dispose());

const getScope = async (userId: string, organizationId: string) => {
  const res = await handler(
    new Request("http://localhost/api/scope", {
      headers: { "x-test-user": userId, "x-test-org": organizationId },
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; stack: ReadonlyArray<{ id: string }> };
};

test("concurrent requests with distinct identities get disjoint, correct scope stacks", async () => {
  // 6 identities × 8 interleaved requests each = 48 concurrent requests over
  // the one long-lived SQLite handle.
  const identities = Array.from({ length: 6 }, (_, i) => ({
    userId: `user-${i}`,
    organizationId: `org-${i}`,
  }));
  const requests = Array.from({ length: 48 }, (_, i) => identities[i % identities.length]);

  const results = await Promise.all(requests.map((id) => getScope(id.userId, id.organizationId)));

  results.forEach((scope, i) => {
    const { userId, organizationId } = requests[i];
    // Each response reflects ONLY its own request's identity — no bleed.
    expect(scope.id).toBe(organizationId);
    expect(scope.stack.map((s) => s.id)).toEqual([
      `user-org:${userId}:${organizationId}`,
      organizationId,
    ]);
  });
});

test("a request with no identity is rejected", async () => {
  const res = await handler(new Request("http://localhost/api/scope"));
  // singleAdmin never returns null, but the header provider does -> the
  // middleware's unauthenticated path fires.
  expect(res.status).toBeGreaterThanOrEqual(400);
});
