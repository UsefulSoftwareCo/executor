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

test("the single-admin binding resolves the org tenant for connection reads", async () => {
  // The connections surface is authenticated and reads the per-request executor's
  // (tenant, subject) binding. Registering an integration + org connection and
  // reading it back proves the single-admin identity resolves to a live executor
  // bound to its org tenant (the v2 successor to the old /api/scope probe).
  const add = await handler(
    new Request("http://localhost/api/openapi/specs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spec: { kind: "blob", value: TINY_SPEC },
        slug: "tiny",
        baseUrl: "",
      }),
    }),
  );
  expect(add.status).toBe(200);

  const created = await handler(
    new Request("http://localhost/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner: "org",
        name: "main",
        integration: "tiny",
        template: "bearer",
        value: "token",
      }),
    }),
  );
  expect(created.status).toBe(200);

  const list = await handler(new Request("http://localhost/api/connections"));
  expect(list.status).toBe(200);
  const connections = (await list.json()) as ReadonlyArray<{ address: string }>;
  expect(connections.some((c) => c.address === "tools.tiny.org.main")).toBe(true);
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
  const body = (await res.json()) as {
    status: string;
    text: string;
    isError: boolean;
  };
  expect(body.status).toBe("completed");
  expect(body.text).toBe("42");
  expect(body.isError).toBe(false);
});
