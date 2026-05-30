import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

// Config reads the environment, so point it at a throwaway data dir before
// importing the app graph.
process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-boot-"));

const { makeSelfHostTestApp, singleAdminIdentityLayer } = await import("./testing/test-app");

const { handler, dispose } = await makeSelfHostTestApp({
  identity: singleAdminIdentityLayer({
    userId: "admin",
    organizationId: "default-org",
    organizationName: "Default",
  }),
});
afterAll(() => dispose());

test("GET /scope returns the single-admin org scope stack", async () => {
  const res = await handler(new Request("http://localhost/api/scope"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string; stack: ReadonlyArray<{ id: string }> };
  expect(body.id).toBe("default-org");
  expect(body.stack.map((s) => s.id)).toEqual(["user-org:admin:default-org", "default-org"]);
});

test("POST /executions runs code in the QuickJS sandbox", async () => {
  const res = await handler(
    new Request("http://localhost/api/executions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "export default 6 * 7" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; text: string; isError: boolean };
  expect(body.status).toBe("completed");
  expect(body.text).toBe("42");
  expect(body.isError).toBe(false);
});
