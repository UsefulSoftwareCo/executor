/** Generated management metadata must use the served contract without exposing private transports. */
import assert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { localManagementDocument } from "../src/contracts/management.ts";
import { executorAppSource } from "../src/implementation/executor-app-source.ts";

test("local management compiles HTTP schemas and only publishes agent-safe operations", async () => {
  const files = await Effect.runPromise(
    executorAppSource().pipe(Effect.provide(NodeServices.layer)),
  );
  const file = files.find((file) => file.path === "operations.json");
  assert.ok(file);
  const metadata = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        operations: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            path: Schema.String,
            security: Schema.Array(Schema.Array(Schema.String)),
            baseUrl: Schema.String,
            description: Schema.String,
          }),
        ),
      }),
    ),
  )(file.content);
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
    assert.deepEqual(operation.security, [["apiKey"]]);
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
