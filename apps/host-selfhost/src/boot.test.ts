import { mkdtempSync } from "node:fs";
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
      body: JSON.stringify({ idempotencyKey: "boot-test", code: "export default 6 * 7" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    executionId: string;
    status: string;
    text: string;
    isError: boolean;
    requestHash: string;
    resultHash: string;
    completedAt: number;
  };
  expect(body.status).toBe("completed");
  expect(body.text).toBe("42");
  expect(body.isError).toBe(false);
  expect(body.executionId).toMatch(/^exec_[a-f0-9]{64}$/);
  expect(body.requestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(body.resultHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(body.completedAt).toEqual(expect.any(Number));

  const readback = await handler(
    new Request(`http://localhost/api/executions/${body.executionId}`),
  );
  expect(readback.status).toBe(200);
  expect(await readback.json()).toStrictEqual(body);

  const replay = await handler(
    new Request("http://localhost/api/executions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "boot-test", code: "export default 6 * 7" }),
    }),
  );
  expect(replay.status).toBe(200);
  expect(await replay.json()).toStrictEqual(body);

  const conflict = await handler(
    new Request("http://localhost/api/executions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "boot-test", code: "export default 7 * 7" }),
    }),
  );
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({
    _tag: "ExecutionIdempotencyConflictError",
    executionId: body.executionId,
  });
});

test("paused executions replay and read back with the same stable id", async () => {
  const artifactResponse = await handler(
    new Request("http://localhost/api/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Paused replay fixture",
        code: "function App() { return <div>Paused replay fixture</div>; }",
      }),
    }),
  );
  expect(artifactResponse.status).toBe(200);
  const artifact = (await artifactResponse.json()) as { id: string };

  const request = {
    idempotencyKey: "paused-replay-test",
    code: `return await tools.executor.coreTools.policies.create(${JSON.stringify({
      owner: "user",
      pattern: "paused-replay-fixture.*",
      action: "block",
    })})`,
    artifactId: artifact.id,
  };
  const first = await handler(
    new Request("http://localhost/api/executions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
  expect(first.status).toBe(200);
  const receipt = (await first.json()) as {
    executionId: string;
    pauseSequence: number;
    status: string;
  };
  expect(receipt.status).toBe("paused");
  expect(receipt.pauseSequence).toBe(0);

  const replay = await handler(
    new Request("http://localhost/api/executions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
  expect(replay.status).toBe(200);
  expect(await replay.json()).toStrictEqual(receipt);

  const readback = await handler(
    new Request(`http://localhost/api/executions/${receipt.executionId}`),
  );
  expect(readback.status).toBe(200);
  expect(await readback.json()).toStrictEqual(receipt);

  const resumeRequest = {
    idempotencyKey: "paused-replay-decline",
    pauseSequence: receipt.pauseSequence,
    action: "decline",
  };
  const declined = await handler(
    new Request(`http://localhost/api/executions/${receipt.executionId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(resumeRequest),
    }),
  );
  expect(declined.status).toBe(200);
  const completed = await declined.json();
  expect(completed).toMatchObject({ executionId: receipt.executionId, status: "completed" });

  const replayedDecline = await handler(
    new Request(`http://localhost/api/executions/${receipt.executionId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(resumeRequest),
    }),
  );
  expect(replayedDecline.status).toBe(200);
  expect(await replayedDecline.json()).toStrictEqual(completed);

  const changedResume = await handler(
    new Request(`http://localhost/api/executions/${receipt.executionId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...resumeRequest, action: "cancel" }),
    }),
  );
  expect(changedResume.status).toBe(409);
  expect(await changedResume.json()).toMatchObject({
    _tag: "ExecutionResumeConflictError",
    executionId: receipt.executionId,
    pauseSequence: receipt.pauseSequence,
  });
});

test("GET /executions refuses malformed and missing ids", async () => {
  const malformed = await handler(new Request("http://localhost/api/executions/not-an-id"));
  expect(malformed.status).toBe(400);

  const missing = await handler(new Request("http://localhost/api/executions/exec_missing"));
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({
    _tag: "ExecutionNotFoundError",
    executionId: "exec_missing",
  });
});

test("POST /executions refuses malformed idempotency keys", async () => {
  const missing = await handler(
    new Request("http://localhost/api/executions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "export default 1" }),
    }),
  );
  expect(missing.status).toBe(400);

  const empty = await handler(
    new Request("http://localhost/api/executions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "", code: "export default 1" }),
    }),
  );
  expect(empty.status).toBe(400);

  const tooLong = await handler(
    new Request("http://localhost/api/executions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "x".repeat(201), code: "export default 1" }),
    }),
  );
  expect(tooLong.status).toBe(400);
});
