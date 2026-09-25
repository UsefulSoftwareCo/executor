import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Cause, Deferred, Effect, Exit, Fiber, Redacted, Schema, Tracer } from "effect";
import { TestClock } from "effect/testing";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import {
  AutumnClient,
  AutumnRequestFailed,
  AutumnServerUrl,
  autumnTimeout,
} from "../src/contracts/autumn.ts";
import { autumnLive } from "../src/implementation/autumn-client.ts";

const secret = "synthetic-autumn-key";
const capability = "synthetic-private-instance";
const options = {
  secretKey: Redacted.make(secret),
  serverUrl: Redacted.make(`https://fixture.test/autumn/${capability}/`),
};
const usage = { feature_id: "executions", usage: 2, remaining: 98, unlimited: false };
const decodedUsage = { featureId: "executions", usage: 2, remaining: 98, unlimited: false };
const input = {
  customerId: "fixture",
  featureId: "executions",
  requiredBalance: 1,
  sendEvent: true,
};

test("seven operations preserve wire fields, API version and emulator path, and trace each round trip without credentials", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const spans: Tracer.NativeSpan[] = [];
  const responses: Record<string, unknown> = {
    "customers.get_or_create": {
      balances: { executions: usage },
      subscriptions: [{ plan_id: "free", status: "active" }],
      email: "ignored@example.test",
    },
    "plans.list": {
      list: [
        {
          id: "team",
          name: "Team",
          group: "fixture",
          archived: false,
          price: null,
          items: [{ feature_id: "members", price: { amount: 15, interval: "month" } }],
        },
      ],
    },
    "balances.check": { allowed: true, balance: usage },
    "balances.update": { success: true },
    "billing.attach": { payment_url: "https://checkout.example.test/fixture" },
    "billing.open_customer_portal": { url: "https://billing.example.test/fixture" },
    "billing.update": { success: true },
  };
  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
      assert.equal(web.method, "POST");
      assert.equal(web.headers.get("authorization"), `Bearer ${secret}`);
      assert.equal(web.headers.get("x-api-version"), "2.3.0");
      assert.equal(web.headers.get("content-type"), "application/json");
      assert.equal(web.headers.get("accept"), "application/json");
      assert.ok(url.pathname.startsWith(`/autumn/${capability}/v1/`));
      const path = url.pathname.split("/").at(-1);
      assert.ok(path && Object.hasOwn(responses, path));
      requests.push({ path, body: yield* Effect.promise(() => web.json()) });
      return HttpClientResponse.fromWeb(request, Response.json(responses[path]));
    }),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* AutumnClient;
      assert.deepEqual(
        yield* client.getOrCreateCustomer({ customerId: "fixture", autoEnablePlanId: "free" }),
        {
          balances: { executions: decodedUsage },
          subscriptions: [{ planId: "free", status: "active" }],
        },
      );
      assert.deepEqual(yield* client.listPlans({ customerId: "fixture" }), {
        list: [
          {
            id: "team",
            name: "Team",
            group: "fixture",
            archived: false,
            price: null,
            items: [{ featureId: "members", price: { amount: 15, interval: "month" } }],
          },
        ],
      });
      assert.deepEqual(yield* client.check(input), { allowed: true, balance: decodedUsage });
      assert.deepEqual(
        yield* client.updateBalance({ customerId: "fixture", featureId: "members", usage: 3 }),
        { success: true },
      );
      assert.deepEqual(
        yield* client.attach({
          customerId: "fixture",
          planId: "team",
          successUrl: "https://executor.test/return",
        }),
        { paymentUrl: "https://checkout.example.test/fixture" },
      );
      assert.deepEqual(
        yield* client.openCustomerPortal({
          customerId: "fixture",
          returnUrl: "https://executor.test/return",
        }),
        { url: "https://billing.example.test/fixture" },
      );
      // Cancelling is an update carrying a cancel action. The contract reads no
      // field from the reply, so the invoice and proration detail passes through.
      assert.deepEqual(
        yield* client.cancelSubscription({
          customerId: "fixture",
          planId: "team",
          cancelAction: "cancel_immediately",
        }),
        { success: true },
      );
    }).pipe(
      Effect.provide(autumnLive(options)),
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(
        Tracer.Tracer,
        Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        }),
      ),
    ),
  );
  assert.deepEqual(requests, [
    {
      path: "customers.get_or_create",
      body: { customer_id: "fixture", auto_enable_plan_id: "free" },
    },
    { path: "plans.list", body: { customer_id: "fixture" } },
    {
      path: "balances.check",
      body: {
        customer_id: "fixture",
        feature_id: "executions",
        required_balance: 1,
        send_event: true,
      },
    },
    { path: "balances.update", body: { customer_id: "fixture", feature_id: "members", usage: 3 } },
    {
      path: "billing.attach",
      body: {
        customer_id: "fixture",
        plan_id: "team",
        success_url: "https://executor.test/return",
      },
    },
    {
      path: "billing.open_customer_portal",
      body: { customer_id: "fixture", return_url: "https://executor.test/return" },
    },
    {
      path: "billing.update",
      body: { customer_id: "fixture", plan_id: "team", cancel_action: "cancel_immediately" },
    },
  ]);
  // Each operation span has one client span for its HTTP round trip.
  const operations = spans.filter((span) => span.name !== "autumn.http");
  const exchanges = spans.filter((span) => span.name === "autumn.http");
  assert.equal(operations.length, 7);
  assert.ok(operations.every((span) => span.name.startsWith("autumn.")));
  assert.deepEqual(
    exchanges.map((span) => ({
      parent: operations.find(
        (operation) => span.parent._tag === "Some" && operation.spanId === span.parent.value.spanId,
      )?.name,
      kind: span.kind,
      attributes: Object.fromEntries(span.attributes),
    })),
    requests.map((request, index) => ({
      parent: operations[index]?.name,
      kind: "client",
      attributes: {
        "http.request.method": "POST",
        "server.address": "fixture.test",
        "autumn.path": `/v1/${request.path}`,
        "http.response.status_code": 200,
      },
    })),
  );
  const captured = JSON.stringify(
    spans.map((span) => ({ name: span.name, attributes: [...span.attributes] })),
  );
  assert.ok(!captured.includes(secret) && !captured.includes(capability));
});

test("errors, fail-open responses and malformed replies fail without retrying a consumption", async () => {
  for (const [status, body] of [
    [401, "{}"],
    [429, "{}"],
    [500, "{}"],
    [202, JSON.stringify({ allowed: true, balance: usage })],
    [200, "not-json"],
    [200, JSON.stringify({ allowed: true })],
    [200, JSON.stringify({ allowed: true, balance: { ...usage, usage: secret } })],
  ] as const) {
    let attempts = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        attempts++;
        return HttpClientResponse.fromWeb(request, new Response(body, { status }));
      }),
    );
    const error = await Effect.runPromise(
      Effect.flatMap(AutumnClient, (client) => client.check(input)).pipe(
        Effect.provide(autumnLive(options)),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.flip,
      ),
    );
    assert.ok(Schema.is(AutumnRequestFailed)(error));
    assert.equal(error.status, status);
    assert.equal(error.reason, status === 200 ? "response" : "status");
    assert.equal(attempts, 1);
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.ok(!JSON.stringify(error).includes(capability));
  }
});

test("provider denial and a missing balance stay explicit results; failed seat updates fail", async () => {
  const http = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json(
          request.url.endsWith("balances.update")
            ? { success: false }
            : { allowed: false, balance: null },
        ),
      ),
    ),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* AutumnClient;
      assert.deepEqual(yield* client.check(input), { allowed: false, balance: null });
      const error = yield* client
        .updateBalance({ customerId: "fixture", featureId: "members", usage: 3 })
        .pipe(Effect.flip);
      assert.equal(error.reason, "response");
    }).pipe(
      Effect.provide(autumnLive(options)),
      Effect.provideService(HttpClient.HttpClient, http),
    ),
  );
});

test("timeout and caller cancellation abort the transport and never retry", async () => {
  for (const mode of ["timeout", "cancel"] as const) {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          let attempts = 0,
            aborted = false;
          const http = HttpClient.make((_request, _url, signal) =>
            Effect.gen(function* () {
              attempts++;
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                },
                { once: true },
              );
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
          );
          const client = yield* AutumnClient.pipe(
            Effect.provide(autumnLive(options)),
            Effect.provideService(HttpClient.HttpClient, http),
          );
          const fiber = yield* client.check(input).pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          if (mode === "timeout") yield* TestClock.adjust(autumnTimeout);
          else yield* Fiber.interrupt(fiber);
          const exit = yield* Fiber.await(fiber);
          assert.ok(Exit.isFailure(exit));
          if (mode === "cancel") assert.ok(Cause.hasInterruptsOnly(exit.cause));
          else {
            const failure = Cause.squash(exit.cause);
            assert.ok(Schema.is(AutumnRequestFailed)(failure));
            assert.equal(failure.reason, "timeout");
          }
          assert.equal(attempts, 1);
          assert.equal(aborted, true);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  }
});

test("the real Fetch adapter does not follow redirects or send the key to the next endpoint", async () => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(302, { location: "/unexpected" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const error = await Effect.runPromise(
      Effect.flatMap(AutumnClient, (client) => client.check(input)).pipe(
        Effect.provide(
          autumnLive({
            ...options,
            serverUrl: Redacted.make(`http://127.0.0.1:${address.port}/fixture`),
          }),
        ),
        Effect.provide(FetchHttpClient.layer),
        Effect.flip,
      ),
    );
    assert.equal(error.status, 302);
    assert.deepEqual(paths, ["/fixture/v1/balances.check"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("the provider endpoint is constrained like a credential", () => {
  for (const allowed of [
    "https://api.useautumn.com",
    "https://billing.internal.example/autumn/instance",
    "https://autumn.example.test/instance",
  ])
    assert.equal(Schema.is(AutumnServerUrl)(allowed), true, allowed);
  for (const refused of [
    "http://api.useautumn.com",
    "https://user:pass@api.useautumn.com",
    "https://api.useautumn.com?token=1",
    "https://api.useautumn.com#fragment",
    "not a url",
  ])
    assert.equal(Schema.is(AutumnServerUrl)(refused), false, refused);
});
