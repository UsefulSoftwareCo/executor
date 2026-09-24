/** Generated management metadata must use the served contract without exposing private transports. */
import assert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { test } from "node:test";
import { Effect } from "effect";
import { compileOpenApi } from "@executor-js/app-templates";
import { localManagementDocument } from "../src/contracts/management.ts";
import { executorAppSource } from "../src/implementation/executor-app-source.ts";

test("local management compiles HTTP schemas and only publishes agent-safe operations", async () => {
  const files = await Effect.runPromise(
    executorAppSource().pipe(Effect.provide(NodeServices.layer)),
  );
  assert.ok(files.some((file) => file.path === "openapi.json"));
  assert.ok(!files.some((file) => file.path === "operations.json"));
  assert.match(
    files.find((file) => file.path === "index.ts")?.content ?? "",
    /liveOpenapiOperations/,
  );
  const metadata = await Effect.runPromise(
    compileOpenApi({ name: "Executor" }, localManagementDocument(), {
      baseUrl: "http://localhost",
    }),
  );
  const names = metadata.operations.map((operation) => operation.name);
  for (const name of [
    "apps_deploy",
    "apps_source",
    "apps_rename",
    "accounts_add",
    "accounts_replaceCredentials",
    "accountConnect_issue",
    "accountConnections_get",
    "webhookLinks_link",
    "webhooks_create",
  ]) {
    assert.ok(names.includes(name), name);
  }
  for (const name of [
    "accountConnect_submit",
    "accountConnect_startOAuth",
    "accountConnections_submit",
    "webhookSetup_read",
    "webhookSetup_complete",
    "webhooks_deliver",
    "tools_resume",
    "tools_pruneApprovals",
    "appData_subscribe",
  ]) {
    assert.ok(!names.includes(name), name);
  }
  for (const operation of metadata.operations) {
    assert.deepEqual(operation.request.security, [{ apiKey: [] }]);
    assert.equal(operation.baseUrl, "http://localhost");
  }
  const document = localManagementDocument();
  assert.deepEqual(
    [...new Set(metadata.operations.map((op) => op.path))].sort(),
    Object.keys(document.paths).sort(),
  );
  assert.match(
    metadata.operations.find((op) => op.name === "accountConnect_issue")?.description ?? "",
    /Never ask for secrets in chat/,
  );
  assert.match(
    metadata.operations.find((op) => op.name === "webhookLinks_link")?.description ?? "",
    /never ask them to paste secrets/,
  );
});
