import { describe, expect, it, onTestFinished } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";

import { RequestBackgroundTasks, requestScopedMiddleware } from "./request-scoped";

class Resource extends Context.Service<Resource, { readonly id: number; closed: boolean }>()(
  "test/RequestResource",
) {}

const fixture = (
  options: {
    background?: boolean;
    failTask?: boolean;
    failRequest?: boolean;
    blockRequest?: boolean;
  } = {},
) => {
  const resources: Resource["Service"][] = [];
  const gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const keptAlive: Promise<void>[] = [];
  const writes: number[] = [];
  const entered = Promise.withResolvers<void>();
  const resource = Layer.effect(Resource)(
    Effect.acquireRelease(
      Effect.sync(() => {
        const acquired = { id: resources.length, closed: false };
        resources.push(acquired);
        gates.push(Promise.withResolvers<void>());
        return acquired;
      }),
      (acquired) =>
        Effect.sync(() => {
          acquired.closed = true;
        }),
    ),
  );
  const routes = HttpRouter.add(
    "GET",
    "/",
    Effect.gen(function* () {
      const acquired = yield* Resource;
      if (options.background !== false) {
        const tasks = yield* RequestBackgroundTasks;
        const gate = gates[acquired.id];
        if (!gate) return yield* Effect.die("Missing request gate");
        const task = Effect.runPromise(
          Effect.gen(function* () {
            yield* Effect.promise(() => gate.promise);
            if (options.failTask) return yield* Effect.fail("Background failure");
            if (acquired.closed)
              return yield* Effect.fail("Resource closed before background write");
            writes.push(acquired.id);
          }),
        );
        keptAlive.push(tasks.retain(task));
      }
      entered.resolve();
      if (options.blockRequest) return yield* Effect.never;
      if (options.failRequest) return yield* Effect.die("Request failure");
      return HttpServerResponse.empty();
    }),
  );
  const app = HttpRouter.toWebHandler(
    routes.pipe(
      Layer.provide(requestScopedMiddleware(resource).layer),
      Layer.provideMerge(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
  onTestFinished(async () => {
    for (const gate of gates) gate.resolve();
    await Promise.all(keptAlive);
    await app.dispose();
  });
  return {
    resources,
    gates,
    keptAlive,
    writes,
    entered,
    request: (signal?: AbortSignal) =>
      app.handler(new Request("http://test.local/", { signal }), Context.empty()),
  };
};

describe("request background resource ownership", () => {
  it("returns the response before background work, and releases after its write", async () => {
    const test = fixture();
    expect((await test.request()).status).toBe(204);
    expect(test.resources.map((item) => item.closed)).toEqual([false]);
    expect(test.writes).toEqual([]);
    test.gates[0]?.resolve();
    await Promise.all(test.keptAlive);
    expect(test.writes).toEqual([0]);
    expect(test.resources.map((item) => item.closed)).toEqual([true]);
  });

  it("keeps concurrent requests isolated and releases each independently", async () => {
    const test = fixture();
    const responses = await Promise.all([test.request(), test.request()]);
    expect(responses.map((response) => response.status)).toEqual([204, 204]);
    test.gates[0]?.resolve();
    await test.keptAlive[0];
    expect(test.resources.map((item) => item.closed)).toEqual([true, false]);
    test.gates[1]?.resolve();
    await test.keptAlive[1];
    expect(test.writes).toEqual([0, 1]);
    expect(test.resources.map((item) => item.closed)).toEqual([true, true]);
  });

  for (const failure of ["task", "request"] as const) {
    it(`releases resources after a ${failure} failure`, async () => {
      const test = fixture({ failTask: failure === "task", failRequest: failure === "request" });
      expect((await test.request()).status).toBe(failure === "request" ? 500 : 204);
      expect(test.resources.map((item) => item.closed)).toEqual([false]);
      test.gates[0]?.resolve();
      await Promise.all(test.keptAlive);
      expect(test.writes).toEqual(failure === "task" ? [] : [0]);
      expect(test.resources.map((item) => item.closed)).toEqual([true]);
    });
  }

  it("closes before responding when no background work was registered", async () => {
    const test = fixture({ background: false });
    expect((await test.request()).status).toBe(204);
    expect(test.resources.map((item) => item.closed)).toEqual([true]);
    expect(test.keptAlive).toEqual([]);
  });

  it("finishes retained work and cleanup after the client cancels the request", async () => {
    const test = fixture({ blockRequest: true });
    const controller = new AbortController();
    const response = test.request(controller.signal);
    await test.entered.promise;
    controller.abort();
    expect((await response).status).toBe(499);
    expect(test.resources.map((item) => item.closed)).toEqual([false]);
    test.gates[0]?.resolve();
    await Promise.all(test.keptAlive);
    expect(test.writes).toEqual([0]);
    expect(test.resources.map((item) => item.closed)).toEqual([true]);
  });
});
