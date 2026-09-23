/** Real ingestion receiver verifies request ownership, safe metadata and failure isolation. */
import { FeedbackUnavailable } from "../src/contracts/feedback.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Cause, Effect, Exit, Schema } from "effect";
import {
  CurrentUserId,
  CurrentOrganization,
  CurrentUsage,
  OrganizationId,
  organizationOwner,
  observeProductOperation,
  recordUsage,
} from "@executor-js/hosted-server";
import {
  withProductAnalytics,
  recordBackgroundUsage,
  submitFeedback,
} from "../src/implementation/product-analytics.ts";

const Batch = Schema.Struct({
  batch: Schema.Array(
    Schema.Struct({
      event: Schema.String,
      distinct_id: Schema.String,
      properties: Schema.Record(Schema.String, Schema.Json),
    }),
  ),
});
class FixtureFailure extends Schema.TaggedError<FixtureFailure>()("FixtureFailure", {
  secret: Schema.String,
}) {}

test("authenticated operations export identity, outcome and timing without payloads; exporter failure preserves results", async () => {
  const batches: Array<typeof Batch.Type> = [];
  let status = 200;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    batches.push(Schema.decodeUnknownSync(Schema.fromJsonString(Batch))(text));
    response.writeHead(status).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const organization = OrganizationId.make("synthetic-org");
    const config = {
      host: `http://127.0.0.1:${address.port}`,
      token: "synthetic-key",
      path: "/api/0123456789abcdef",
      environment: "test-fixture",
      release: "fixture",
      internalUserIds: ["synthetic-user"],
    };
    const send = <A, E>(work: Effect.Effect<A, E>) =>
      Effect.runPromise(
        Effect.scoped(
          withProductAnalytics(
            work.pipe(
              Effect.provideService(CurrentUserId, "synthetic-user"),
              Effect.provideService(CurrentOrganization, {
                organization,
                owner: organizationOwner(organization),
                role: "owner",
              }),
              Effect.provideService(CurrentUsage, {
                source: "mcp",
                client_id: "synthetic-client",
                client_name: "Fixture client",
              }),
            ),
            Effect.succeed(config),
          ),
        ),
      );
    const run = <A, E>(work: Effect.Effect<A, E>) =>
      send(Effect.exit(observeProductOperation({ area: "tools", operation: "call" }, work)));
    const result = { privateValue: "PRIVATE_RESULT" };
    const success = await run(Effect.succeed(result));
    assert.ok(Exit.isSuccess(success));
    assert.equal(success.value, result);
    assert.deepEqual(
      batches[0]?.batch.map((event) => event.event),
      ["product_operation_started", "product_operation_completed"],
    );
    const event = batches[0]?.batch[1];
    assert.equal(event?.distinct_id, "synthetic-user");
    assert.equal(event?.properties.organization_id, organization);
    assert.equal(event?.properties.source, "mcp");
    assert.equal(event?.properties.client_id, "synthetic-client");
    assert.equal(event?.properties.ok, true);
    assert.equal(event?.properties.executor_internal, true);
    assert.deepEqual(event?.properties.$set, { executor_internal: true });
    assert.equal(typeof event?.properties.duration_ms, "number");
    const failure = new FixtureFailure({ secret: "PRIVATE_ERROR" });
    const failed = await run(Effect.fail(failure));
    assert.ok(Exit.isFailure(failed));
    assert.equal(Cause.squash(failed.cause), failure);
    assert.equal(batches[1]?.batch[1]?.properties.error_type, "FixtureFailure");
    assert.equal(batches[1]?.batch[1]?.properties.outcome, "failure");
    const interrupted = await run(Effect.interrupt);
    assert.ok(Exit.isFailure(interrupted));
    assert.equal(batches[2]?.batch[1]?.properties.outcome, "cancelled");
    assert.ok(!JSON.stringify(batches).includes("PRIVATE_"));
    status = 503;
    const unaffected = await run(Effect.succeed(result));
    assert.ok(Exit.isSuccess(unaffected));
    assert.equal(unaffected.value, result);
    status = 200;
    await send(
      recordBackgroundUsage("workflow_attempt_completed", "fixture", {
        run_id: "run-fixture",
        ok: true,
      }),
    );
    assert.equal(batches.at(-1)?.batch[0]?.properties.$process_person_profile, false);
    await send(Effect.forEach(Array.from({ length: 1005 }), () => recordUsage("app_viewed")));
    assert.equal(batches.at(-1)?.batch.length, 1001);
    assert.equal(batches.at(-1)?.batch.at(-1)?.properties.dropped_events, 5);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("disabled analytics preserves product results and rejects explicit feedback", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      withProductAnalytics(
        observeProductOperation({ area: "tools", operation: "call" }, Effect.succeed("completed")),
        Effect.succeed(undefined),
      ),
    ),
  );
  assert.equal(result, "completed");
  const organization = OrganizationId.make("synthetic-org");
  const feedback = await Effect.runPromise(
    Effect.exit(
      submitFeedback({ message: "Synthetic feedback" }).pipe(
        Effect.provideService(CurrentUserId, "synthetic-user"),
        Effect.provideService(CurrentOrganization, {
          organization,
          owner: organizationOwner(organization),
          role: "owner",
        }),
      ),
    ),
  );
  assert.ok(Exit.isFailure(feedback));
  assert.ok(Cause.squash(feedback.cause) instanceof FeedbackUnavailable);
});
