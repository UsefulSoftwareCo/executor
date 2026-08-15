import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

import { mintInviteCode } from "../testing/mint-invite";

// The self-host access-groups plane (`/api/admin/access-groups*`), over the
// REAL booted app. What this pins: the mount is live, the shared owner/admin
// gate refuses a plain member (403) and an anonymous caller (401), and the
// admin can run the group CRUD + membership round trip. Enforcement semantics
// (who then sees what) are covered by the sdk's
// access-group-enforcement.test.ts — this is the HTTP gate.

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-access-groups-"));
process.env.BETTER_AUTH_SECRET = "access-groups-test-secret-0123456789-abcdef";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@access-groups.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";

const { makeSelfHostApiHandler } = await import("../app");
const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

const BASE = "http://localhost:4788";

const signIn = async (email: string, password: string): Promise<string> => {
  const response = await handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  return response.headers.get("set-auth-token") ?? "";
};

const request = (
  path: string,
  options: { readonly method?: string; readonly token?: string; readonly body?: unknown } = {},
) =>
  handler(
    new Request(`${BASE}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    }),
  );

test("only the instance admin can manage access groups", async () => {
  const adminToken = await signIn(
    process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL!,
    process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD!,
  );
  expect(adminToken).not.toBe("");

  // A plain member joins through the real invite flow.
  const inviteCode = await mintInviteCode(handler);
  const signUp = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "member@access-groups.test",
        password: "password-12345678",
        name: "Member",
        inviteCode,
      }),
    }),
  );
  expect(signUp.status).toBe(200);
  const memberToken = signUp.headers.get("set-auth-token") ?? "";
  expect(memberToken).not.toBe("");

  // Anonymous → 401; plain member → 403; on reads AND writes.
  expect((await request("/api/admin/access-groups")).status).toBe(401);
  expect((await request("/api/admin/access-groups", { token: memberToken })).status).toBe(403);
  expect(
    (
      await request("/api/admin/access-groups", {
        method: "POST",
        token: memberToken,
        body: { name: "finance" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/api/admin/access-group-restrictions", {
        method: "POST",
        token: memberToken,
        body: { integration: "github", name: "main", group: "grp_x" },
      })
    ).status,
  ).toBe(403);

  // The admin's round trip: create → list → add member → list members → delete.
  const created = await request("/api/admin/access-groups", {
    method: "POST",
    token: adminToken,
    body: { name: "finance" },
  });
  expect(created.status).toBe(200);
  const group = (await created.json()) as { id: string; name: string };
  expect(group.name).toBe("finance");

  const listed = await request("/api/admin/access-groups", { token: adminToken });
  expect(listed.status).toBe(200);
  expect(((await listed.json()) as { groups: unknown[] }).groups).toHaveLength(1);

  const added = await request(`/api/admin/access-groups/${group.id}/members`, {
    method: "POST",
    token: adminToken,
    body: { subject: "some-user-id" },
  });
  expect(added.status).toBe(200);

  const members = await request(`/api/admin/access-groups/${group.id}/members`, {
    token: adminToken,
  });
  expect(members.status).toBe(200);
  expect(
    ((await members.json()) as { members: readonly { subject: string }[] }).members.map(
      (member) => member.subject,
    ),
  ).toEqual(["some-user-id"]);

  // Restricting a connection that doesn't exist is a 404, not a leak of
  // anything else.
  const missing = await request("/api/admin/access-group-restrictions", {
    method: "POST",
    token: adminToken,
    body: { integration: "github", name: "missing", group: group.id },
  });
  expect(missing.status).toBe(404);

  // Toolkit grants ride the same gate: member is refused, admin round-trips
  // against a real toolkit created through the product API.
  expect(
    (
      await request("/api/admin/access-group-toolkit-restrictions", {
        method: "POST",
        token: memberToken,
        body: { toolkitId: "tk_x", group: group.id },
      })
    ).status,
  ).toBe(403);

  const createdToolkit = await request("/api/toolkits", {
    method: "POST",
    token: adminToken,
    body: { owner: "org", name: "Deploy Kit" },
  });
  expect(createdToolkit.status).toBe(200);
  const toolkit = (await createdToolkit.json()) as { id: string; slug: string };

  const granted = await request("/api/admin/access-group-toolkit-restrictions", {
    method: "POST",
    token: adminToken,
    body: { toolkitId: toolkit.id, group: group.id },
  });
  expect(granted.status).toBe(200);

  const toolkitRestrictions = await request("/api/admin/access-group-toolkit-restrictions", {
    token: adminToken,
  });
  expect(((await toolkitRestrictions.json()) as { restrictions: unknown[] }).restrictions).toEqual([
    { toolkitId: toolkit.id, slug: toolkit.slug, group: group.id },
  ]);

  // Granting to a missing group or a missing toolkit is a 400 with the
  // engine's message, not a silent success.
  expect(
    (
      await request("/api/admin/access-group-toolkit-restrictions", {
        method: "POST",
        token: adminToken,
        body: { toolkitId: toolkit.id, group: "grp_missing" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("/api/admin/access-group-toolkit-restrictions", {
        method: "POST",
        token: adminToken,
        body: { toolkitId: "tk_missing", group: group.id },
      })
    ).status,
  ).toBe(400);

  // Deleting the group while a toolkit still references it is refused — a
  // dangling grant would hide the toolkit from everyone.
  expect(
    (await request(`/api/admin/access-groups/${group.id}`, { method: "DELETE", token: adminToken }))
      .status,
  ).toBe(400);

  const ungranted = await request(`/api/admin/access-group-toolkit-restrictions/${toolkit.id}`, {
    method: "DELETE",
    token: adminToken,
  });
  expect(ungranted.status).toBe(200);

  const removed = await request(`/api/admin/access-groups/${group.id}`, {
    method: "DELETE",
    token: adminToken,
  });
  expect(removed.status).toBe(200);
  const after = await request("/api/admin/access-groups", { token: adminToken });
  expect(((await after.json()) as { groups: unknown[] }).groups).toHaveLength(0);
});
