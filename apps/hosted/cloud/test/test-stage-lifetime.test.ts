/** Fixed deadlines apply to HTTP requests and background work, with cleanup access retained. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { previewLifetime } from "../src/infrastructure/test-stage-expiry.ts";
import {
  canDeployTestStage,
  testStageCleanupAt,
  testStageLifetimeMilliseconds,
} from "../src/contracts/test-stage-lifetime.ts";

const lease = {
  slug: "fixture",
  owner: "fixture",
  createdAt: 0,
  expiresAt: testStageLifetimeMilliseconds,
};
test("the deadline has a cleanup window and cannot be prolonged by a deploy", () => {
  assert.equal(testStageCleanupAt(lease), 165 * 60 * 1000);
  assert.equal(canDeployTestStage(lease, 135 * 60 * 1000), true);
  assert.equal(canDeployTestStage(lease, 135 * 60 * 1000 + 1), false);
});
const call = (stage: string, expiresAt: number, path: string, method = "GET") =>
  Effect.runPromise(
    Effect.gen(function* () {
      const lifetime = yield* previewLifetime;
      let ran = false;
      yield* lifetime.background(
        Effect.sync(() => {
          ran = true;
        }),
      );
      const response = yield* lifetime
        .http(Effect.succeed(HttpServerResponse.empty({ status: 204 })))
        .pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`https://fixture.executor.engineering${path}`, { method }),
            ),
          ),
        );
      return { status: response.status, ran };
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          ALCHEMY_STAGE: stage,
          TEST_STAGE_EXPIRES_AT: expiresAt,
        }),
      ),
    ),
  );
test("expired previews reject requests and stop background work", async () => {
  assert.deepEqual(await call("test-fixture", 1, "/api/apps"), { status: 410, ran: false });
});
test("cleanup can still reach its separately authenticated drain endpoint after expiry", async () => {
  assert.deepEqual(await call("test-fixture", 1, "/api/internal/app-domains/drain", "POST"), {
    status: 204,
    ran: false,
  });
  assert.equal(
    (await call("test-fixture", 1, "/api/internal/app-domains/drain", "GET")).status,
    410,
  );
});
test("production has no staging deadline; active previews continue normally", async () => {
  assert.deepEqual(await call("v2", 1, "/api/apps"), { status: 204, ran: true });
  assert.deepEqual(await call("test-fixture", Date.now() + 60000, "/api/apps"), {
    status: 204,
    ran: true,
  });
});
