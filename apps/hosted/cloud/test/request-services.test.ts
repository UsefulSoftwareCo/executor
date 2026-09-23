import assert from "node:assert/strict";
import { test } from "node:test";
import { Context, Effect, Layer } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { requestServices } from "@executor-js/hosted-server";

class RequestLease extends Context.Service<
  RequestLease,
  { readonly actor: string; readonly active: () => boolean }
>()("test/RequestLease") {}

test("one router gives concurrent and later requests independent, scoped services", async () => {
  const acquired: string[] = [];
  const released: string[] = [];
  const live = Layer.effect(
    RequestLease,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const actor = request.headers["x-actor"] ?? "anonymous";
      let active = true;
      acquired.push(actor);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          active = false;
          released.push(actor);
        }),
      );
      return { actor, active: () => active };
    }),
  );
  const routes = HttpRouter.add(
    "GET",
    "/",
    Effect.gen(function* () {
      const lease = yield* RequestLease;
      yield* Effect.yieldNow;
      assert.equal(lease.active(), true);
      return HttpServerResponse.text(lease.actor);
    }),
  ).pipe(Layer.provide(requestServices(live).layer), Layer.provide(HttpServer.layerServices));
  const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const request = async (actor: string) => {
    const response = await web.handler(
      new Request("https://fixture.test/", { headers: { "x-actor": actor } }),
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), actor);
  };
  try {
    await Promise.all([request("alice"), request("bob"), request("carol")]);
    await request("dana");
    assert.deepEqual(acquired.toSorted(), ["alice", "bob", "carol", "dana"]);
    assert.deepEqual(released.toSorted(), acquired.toSorted());
  } finally {
    await web.dispose();
  }
});
