/** Exercise attribution and request-scoped batch delivery at the HTTP boundary. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { heroVisitorCookie } from "@executor-js/marketing/experiments";
import { clearHeroIdentityOnSignOut } from "../src/implementation/hero-experiment.ts";
import {
  recordCloudSignup,
  withProductAnalytics,
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

test("native identification links signup to its anonymous exposure and excludes previews", async () => {
  const batches: Array<typeof Batch.Type> = [];
  let fail = false;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    batches.push(Schema.decodeUnknownSync(Schema.fromJsonString(Batch))(body));
    response.writeHead(fail ? 503 : 200).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const send = (cookie: string) =>
      Effect.runPromise(
        Effect.scoped(
          withProductAnalytics(
            recordCloudSignup("synthetic-new-user").pipe(Effect.as("signed-up")),
            Effect.succeed({
              token: "synthetic-ingestion-key",
              host: `http://127.0.0.1:${address.port}`,
              path: "/api/0123456789abcdef",
              environment: "test-hero",
              release: "fixture",
            }),
          ).pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request("https://cloud.example.test/api/auth/sign-in/email-otp", {
                  headers: { cookie },
                }),
              ),
            ),
          ),
        ),
      );
    const visitor = crypto.randomUUID();
    const cookie = `${heroVisitorCookie}=${visitor}`;
    assert.equal(await send(cookie), "signed-up");
    assert.equal(batches[0]?.batch.length, 2);
    const identify = batches[0]?.batch[0];
    const signup = batches[0]?.batch[1];
    assert.equal(identify?.event, "$identify");
    assert.equal(identify?.distinct_id, "synthetic-new-user");
    assert.equal(identify?.properties.$anon_distinct_id, visitor);
    assert.equal(identify?.properties.$process_person_profile, true);
    assert.equal(signup?.event, "cloud_signup_completed");
    assert.equal(signup?.distinct_id, identify?.distinct_id);
    assert.equal(signup?.properties.executor_test, true);
    await send(`${cookie}; executor_hero_preview=1`);
    assert.equal(batches[1]?.batch.length, 1);
    assert.equal(batches[1]?.batch[0]?.event, "cloud_signup_completed");
    await send(`${heroVisitorCookie}=broken`);
    assert.equal(batches[2]?.batch.length, 1);
    fail = true;
    assert.equal(await send(cookie), "signed-up", "An analytics outage cannot fail signup");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("successful sign-out expires anonymous identity and experiment snapshots", async () => {
  for (const [path, status, expected] of [
    ["/api/auth/sign-out", 200, 3],
    ["/api/auth/sign-out", 500, 0],
    ["/api/auth/get-session", 200, 0],
  ] as const) {
    const response = await Effect.runPromise(
      clearHeroIdentityOnSignOut(HttpServerResponse.empty({ status })).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`https://cloud.example.test${path}`, { method: "POST" }),
          ),
        ),
      ),
    );
    const cookies = HttpServerResponse.toWeb(response).headers.getSetCookie();
    assert.equal(cookies.length, expected);
    if (expected > 0) {
      assert.ok(cookies.every((cookie) => cookie.includes("Max-Age=0")));
      assert.ok(cookies.some((cookie) => cookie.startsWith(`${heroVisitorCookie}=`)));
    }
  }
});
