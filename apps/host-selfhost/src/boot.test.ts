import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test } from "@effect/vitest";

// Config reads the environment, so point it at a throwaway data dir before
// importing the app graph.
process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-boot-"));

let handler!: (request: Request) => Promise<Response>;
let dispose: () => Promise<void> = async () => {};

beforeAll(async () => {
  const { makeSelfHostTestApp, singleAdminIdentityLayer } = await import("./testing/test-app");
  const app = await makeSelfHostTestApp({
    identity: singleAdminIdentityLayer({
      userId: "admin",
      organizationId: "default-org",
      organizationName: "Default",
    }),
  });
  handler = app.handler;
  dispose = app.dispose;
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

test("selfhost rejects local-directory app sources over HTTP", async () => {
  const created = await handler(
    new Request("http://localhost/api/apps/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "local-directory",
        slug: "local-greeter-disabled",
        app: "local-greeter-disabled",
        path: "/tmp/local-greeter-disabled",
      }),
    }),
  );
  expect(created.status).toBe(500);

  const dirs = await handler(new Request("http://localhost/api/apps/fs/dirs"));
  expect(dirs.status).toBe(404);
});

test("apps source sync publishes and invokes a local-directory tool over HTTP", async () => {
  const { makeSelfHostTestApp, singleAdminIdentityLayer } = await import("./testing/test-app");
  const localDirectoryApp = await makeSelfHostTestApp({
    identity: singleAdminIdentityLayer({
      userId: "admin-local-directory",
      organizationId: "default-org-local-directory",
      organizationName: "Default Local Directory",
    }),
    // This test exercises the plugin loop, not the selfhost product posture.
    pluginDeps: { sourceKinds: ["git", "local-directory"] },
  });
  const root = mkdtempSync(join(tmpdir(), "eh-app-src-"));
  mkdirSync(join(root, "tools"), { recursive: true });
  writeFileSync(
    join(root, "tools", "greeter.ts"),
    `
      import { defineTool } from "executor:app";

      export default defineTool({
        description: "Greets through the app source path",
        input: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        async handler(input) {
          return { greeting: "hello " + input.name };
        },
      });
    `,
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "local-greeter" }));

  try {
    const created = await localDirectoryApp.handler(
      new Request("http://localhost/api/apps/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "local-directory",
          slug: "local-greeter",
          app: "local-greeter",
          path: root,
        }),
      }),
    );
    expect(created.status).toBe(200);

    const synced = await localDirectoryApp.handler(
      new Request("http://localhost/api/apps/sources/local-greeter/sync", { method: "POST" }),
    );
    expect(synced.status).toBe(200);
    const syncBody = (await synced.json()) as {
      readonly status: string;
      readonly tools: readonly string[];
      readonly errors?: readonly unknown[];
    };
    expect(syncBody.status, JSON.stringify(syncBody.errors)).toBe("published");
    expect(syncBody.tools).toEqual(["greeter"]);

    const listed = await localDirectoryApp.handler(new Request("http://localhost/api/tools"));
    expect(listed.status).toBe(200);
    const tools = (await listed.json()) as ReadonlyArray<{ readonly address: string }>;
    expect(
      tools.some((tool) => tool.address === "tools.local-greeter.org.published.greeter"),
      JSON.stringify(tools.map((tool) => tool.address)),
    ).toBe(true);

    const invoked = await localDirectoryApp.handler(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: 'export default await tools["local-greeter.org.published.greeter"]({ name: "Ada" })',
        }),
      }),
    );
    expect(invoked.status).toBe(200);
    const output = (await invoked.json()) as { readonly text: string; readonly isError: boolean };
    expect(output.isError).toBe(false);
    expect(output.text).toContain("hello Ada");
  } finally {
    await localDirectoryApp.dispose();
  }
});
