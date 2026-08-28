// ---------------------------------------------------------------------------
// Regression for https://github.com/RhysSullivan/executor/pull/468 — the
// cloud API v4 routing refactor wired DbService.Live (and other I/O-holding
// services) into `Layer.provideMerge` of an `HttpRouter.toWebHandler` app.
// `toWebHandler` builds the layer ONCE at worker boot and reuses the
// resolved Context for every request, so `Effect.acquireRelease` runs only
// at boot. On Cloudflare Workers that means the postgres.js socket (a
// `Writable` I/O object) is opened in request 1's context and reused by
// request 2, which the runtime forbids:
//
//   StorageError: FumaDB findMany select failed:
//     Cannot perform I/O on behalf of a different request. (I/O type: Writable)
//
// The only primitive that actually rebuilds per request is a custom
// `HttpRouter.middleware` whose per-request handler does
// `Layer.build(layer)` inside `Effect.scoped`. `provideMerge` runs the
// layer at boot; `HttpRouter.provideRequest` (despite its name) also runs
// the layer at boot — its `Layer.build` lives in the *outer* middleware
// effect, which executes at layer-construction time. Only an explicit
// `Effect.scoped` inside the per-request handler creates a fresh scope
// for `acquireRelease`.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import {
  CodeExecutorProvider,
  DbProvider,
  EngineDecoratorNoop,
  ExecutorService,
  HostConfig,
  PluginsProvider,
  makeExecutionStackMiddleware,
  requestScopedMiddleware,
  textFailureStrategy,
  type CodeExecutor,
  type IdentityFailure,
  type Principal,
} from "@executor-js/api/server";
import { collectTables } from "@executor-js/sdk";
import { resetSubjectTouchCache } from "@executor-js/sdk/host-internal";
import { createSqliteTestFumaDb, type SqliteTestFumaDb } from "@executor-js/sdk/testing";

import { RequestScopedServicesLive } from "./api/layers";
import { makeApiLive } from "./api/router";

class Counter extends Context.Service<Counter, { readonly id: number }>()("test/Counter") {}

const makeCounterLive = (counts: { acquires: number; releases: number }, acquireDelayMs = 0) =>
  Layer.effect(Counter)(
    Effect.acquireRelease(
      Effect.gen(function* () {
        // Yield to the event loop inside acquire to force concurrent
        // request fibers to overlap on the shared boot MemoMap.
        if (acquireDelayMs > 0) {
          yield* Effect.sleep(`${acquireDelayMs} millis`);
        }
        counts.acquires += 1;
        return { id: counts.acquires };
      }),
      () =>
        Effect.sync(() => {
          counts.releases += 1;
        }),
    ),
  );

const Routes = HttpRouter.add(
  "GET",
  "/",
  Effect.gen(function* () {
    const c = yield* Counter;
    return HttpServerResponse.jsonUnsafe({ id: c.id });
  }),
);

describe("HttpRouter.toWebHandler request scoping", () => {
  it("Layer.provideMerge of a scoped layer captures the boot scope (the bug)", async () => {
    const counts = { acquires: 0, releases: 0 };
    const App = Routes.pipe(
      Layer.provideMerge(makeCounterLive(counts)),
      Layer.provideMerge(HttpServer.layerServices),
    );
    const handler = HttpRouter.toWebHandler(App, { disableLogger: true }).handler;

    const a = await handler(new Request("http://test.local/"));
    const b = await handler(new Request("http://test.local/"));

    // Same id => the resource was acquired once at boot and shared.
    // On Cloudflare Workers this is the I/O-isolation crash mode.
    expect(await a.json()).toEqual({ id: 1 });
    expect(await b.json()).toEqual({ id: 1 });
    expect(counts.acquires).toBe(1);
  });

  it("HttpRouter.provideRequest is misleadingly named — it also captures boot scope", async () => {
    const counts = { acquires: 0, releases: 0 };
    const App = Routes.pipe(
      HttpRouter.provideRequest(makeCounterLive(counts)),
      Layer.provideMerge(HttpServer.layerServices),
    );
    const handler = HttpRouter.toWebHandler(App, { disableLogger: true }).handler;

    const a = await handler(new Request("http://test.local/"));
    const b = await handler(new Request("http://test.local/"));

    // `provideRequest` runs `Layer.build` in the OUTER middleware effect,
    // which fires at layer-construction time — same lifetime as the boot
    // scope. Both requests see the same acquired resource.
    expect(await a.json()).toEqual({ id: 1 });
    expect(await b.json()).toEqual({ id: 1 });
    expect(counts.acquires).toBe(1);
  });

  it("requestScopedMiddleware runs acquireRelease per request (the fix)", async () => {
    const counts = { acquires: 0, releases: 0 };
    const App = Routes.pipe(
      Layer.provide(requestScopedMiddleware(makeCounterLive(counts)).layer),
      Layer.provideMerge(HttpServer.layerServices),
    );
    const handler = HttpRouter.toWebHandler(App, { disableLogger: true }).handler;

    const a = await handler(new Request("http://test.local/"));
    const b = await handler(new Request("http://test.local/"));

    expect(await a.json()).toEqual({ id: 1 });
    expect(await b.json()).toEqual({ id: 2 });
    expect(counts.acquires).toBe(2);
    expect(counts.releases).toBe(2);
  });

  // Concurrent regression: Cloudflare Workers serves multiple in-flight
  // requests from the same isolate. `Layer.build(layer)` (used by
  // `requestScopedMiddleware`) inherits the boot-level `CurrentMemoMap`
  // installed by `HttpRouter.toWebHandler`, so two requests that race
  // through the middleware before either's scope closes BOTH reuse the
  // first request's memoized layer build — sharing one postgres.js socket
  // across two request handlers, which the runtime forbids:
  //   "Cannot perform I/O on behalf of a different request"
  //
  // The fix must give each request a fresh MemoMap so memoization is
  // request-local. Without it, this test acquires only once (and would
  // crash in prod on the second concurrent request's I/O).
  it("requestScopedMiddleware does NOT share a build across concurrent requests", async () => {
    const counts = { acquires: 0, releases: 0 };
    // 5ms async sleep inside acquire forces the two request fibers to
    // overlap on the layer build, the same shape as Cloudflare Workers
    // serving multiple in-flight requests from one isolate.
    const App = Routes.pipe(
      Layer.provide(requestScopedMiddleware(makeCounterLive(counts, 5)).layer),
      Layer.provideMerge(HttpServer.layerServices),
    );
    const handler = HttpRouter.toWebHandler(App, { disableLogger: true }).handler;

    const [a, b] = await Promise.all([
      handler(new Request("http://test.local/")),
      handler(new Request("http://test.local/")),
    ]);

    const aBody = (await a.json()) as { id: number };
    const bBody = (await b.json()) as { id: number };
    // Two concurrent requests must see two distinct acquired counters.
    // Otherwise both fibers share one postgres socket -> Cloudflare
    // Workers I/O isolation crash in prod.
    expect(new Set([aBody.id, bBody.id])).toEqual(new Set([1, 2]));
    expect(counts.acquires).toBe(2);
    expect(counts.releases).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Regression test against the prod handler factory. If anyone reverts
// `makeApiLive` back to wiring `RequestScopedServicesLive` via
// `Layer.provideMerge`, this test fails — the counter only increments
// once at boot instead of once per request.
// ---------------------------------------------------------------------------

describe("makeApiLive (prod handler factory) request scoping", () => {
  it("rebuilds RequestScopedServicesLive per request", async () => {
    const counts = { acquires: 0, releases: 0 };
    // Wrap the real per-request layer with an `acquireRelease` counter.
    // `requestScopedMiddleware` calls `Layer.build` per request, so this
    // counter increments per request iff the wiring is correct.
    const trackedRsLive = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => {
          counts.acquires += 1;
        }),
        () =>
          Effect.sync(() => {
            counts.releases += 1;
          }),
      ),
    ).pipe(Layer.provideMerge(RequestScopedServicesLive));

    const handler = HttpRouter.toWebHandler(makeApiLive(trackedRsLive), {
      disableLogger: true,
    }).handler;

    // Hit a protected route. ExecutionStackMiddleware short-circuits with
    // 403 (no session cookie) but not before `requestScopedMiddleware`
    // has built the per-request layer. We don't care about the response —
    // only that the layer was built once per request. `/integrations` is a
    // v2 protected route (the old `/scope` group was removed).
    await handler(new Request("http://test.local/integrations"), Context.empty());
    await handler(new Request("http://test.local/integrations"), Context.empty());

    expect(counts.acquires).toBe(2);
    expect(counts.releases).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// `ExecutionStackMiddleware` request scoping.
//
// `requestScopedMiddleware` gives every request a fresh `MemoMap`, so the
// per-request DB handle is genuinely per request (the suites above). But
// `makeExecutionStackMiddleware` captures the BOOT fiber's context once, at
// layer-construction time, and re-applies it to every request with
// `Effect.provideContext`. That captured context carries Effect's
// `CurrentMemoMap`, and `provideContext`'s merge lets the BOOT map overwrite
// the fresh per-request one. The per-request `Effect.provide(stackLayer)` then
// memoizes its build in the boot map, which every in-flight request fiber in
// the isolate shares.
//
// Sequential requests still rebuild (the memo entry is refcounted by observer
// and drops to zero when the request scope closes), so only OVERLAPPING
// requests are affected: the second request reuses the first request's stack
// build, and therefore the first request's database handle. On Cloudflare
// Workers that is a cross-request I/O violation; and when the owning request
// finishes, its scope finalizer closes the connection out from under the
// borrower, whose next query fails.
//
// These tests stand the real middleware up over per-request in-memory
// databases and pin all three symptoms.
// ---------------------------------------------------------------------------

interface TestDbHandle {
  readonly id: number;
  readonly db: SqliteTestFumaDb;
  closed: boolean;
}

class TestDb extends Context.Service<TestDb, TestDbHandle>()("test/TestDb") {}

interface StackProbeState {
  /**
   * Databases created up front, one per request the case will make. Handing a
   * ready database to the request-scoped layer keeps its acquire synchronous,
   * so the first request to arrive is reliably the one that owns handle 1 —
   * which is what makes the borrow direction deterministic below.
   */
  readonly pool: readonly SqliteTestFumaDb[];
  /** Handles acquired by `requestScopedMiddleware` — one per request. */
  readonly handles: TestDbHandle[];
  /** How many times the stack layer's `DbProvider` was actually built. */
  builds: number;
  /** The handle id each stack build read. One entry per build. */
  readonly builtWithHandleId: number[];
  /**
   * What each request could see about connection ownership at the moment it
   * performed its read-after-await, keyed by that request's await duration.
   */
  readonly lateReadOwnership: Map<
    number,
    {
      readonly ownHandleId: number;
      readonly ownClosed: boolean;
      readonly otherClosed: readonly boolean[];
    }
  >;
}

const noopCodeExecutor: CodeExecutor = {
  execute: () => Effect.succeed({ result: undefined, logs: [] }),
};

const stackProbePrincipal: Principal = {
  kind: "member",
  accountId: "user_request_scope",
  organizationId: "org_request_scope",
  organizationName: "Request Scope Test Org",
  email: "request-scope@test.local",
  name: "Request Scope",
  avatarUrl: null,
  roles: ["admin"],
};

/**
 * The per-request DB handle, in the slot cloud's postgres.js socket occupies:
 * acquired when the request fiber's scope opens, closed when it closes.
 */
const makeTestDbLive = (state: StackProbeState) =>
  Layer.effect(TestDb)(
    Effect.acquireRelease(
      Effect.sync(() => {
        const index = state.handles.length;
        const handle: TestDbHandle = {
          id: index + 1,
          db: state.pool[index] as SqliteTestFumaDb,
          closed: false,
        };
        state.handles.push(handle);
        return handle;
      }),
      (handle) =>
        // The request's own scope ends its connection, exactly as the host
        // closes the postgres socket when the request finishes.
        Effect.promise(async () => {
          handle.closed = true;
          await handle.db.close();
        }),
    ),
  );

/**
 * The host's `stackLayer` seam, reduced to the parts that matter: a
 * `DbProvider` derived from the REQUEST-scoped handle (exactly cloud's
 * arrangement) plus inert stand-ins for the rest. The 5ms sleep widens the
 * window in which two request fibers overlap on the layer build, which is what
 * an isolate serving concurrent requests does on its own.
 */
const makeTestStackLayer = (state: StackProbeState) =>
  Layer.mergeAll(
    Layer.effect(DbProvider)(
      Effect.gen(function* () {
        const handle = yield* TestDb;
        yield* Effect.sleep("5 millis");
        state.builds += 1;
        state.builtWithHandleId.push(handle.id);
        return handle.db;
      }),
    ),
    Layer.succeed(PluginsProvider)({ plugins: () => [] }),
    Layer.succeed(HostConfig)({ allowLocalNetwork: false, oauthCallbackPath: "/oauth/callback" }),
    Layer.succeed(CodeExecutorProvider)(noopCodeExecutor),
    EngineDecoratorNoop,
  );

/**
 * `GET /probe?delay=N`: one cheap read, a pause standing in for a slow
 * outbound call, then a second read. That is the production shape — an early
 * query succeeds, the request awaits something slow, and by the time it queries
 * again the connection it borrowed has been closed by its real owner.
 */
const makeStackProbeRoutes = (state: StackProbeState) =>
  HttpRouter.add(
    "GET",
    "/probe",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const delayMs = Number(
        new URL(request.url, "http://test.local").searchParams.get("delay") ?? "0",
      );
      const executor = yield* ExecutorService;
      const read = () =>
        executor.connections.list().pipe(
          Effect.as("ok" as const),
          Effect.catchCause(() => Effect.succeed("failed" as const)),
        );

      // The handle this request acquired for itself, whatever order the
      // request fibers happened to acquire in.
      const own = yield* TestDb;

      const early = yield* read();
      yield* Effect.sleep(`${delayMs} millis`);
      state.lateReadOwnership.set(delayMs, {
        ownHandleId: own.id,
        ownClosed: own.closed,
        otherClosed: state.handles.filter((handle) => handle.id !== own.id).map((h) => h.closed),
      });
      const late = yield* read();
      return HttpServerResponse.jsonUnsafe({ early, late });
    }),
  );

const makeStackProbeHandler = (state: StackProbeState) => {
  const ExecutionStackMiddleware = makeExecutionStackMiddleware<
    readonly [],
    IdentityFailure,
    never,
    TestDb,
    never,
    never
  >({
    plugins: [],
    authenticate: () => Effect.succeed(stackProbePrincipal),
    strategy: textFailureStrategy,
    stackLayer: makeTestStackLayer(state),
  });

  const App = makeStackProbeRoutes(state).pipe(
    // Exactly cloud's composition: the stack middleware with the per-request
    // DB layer combined in, so `DbProvider` is built over a handle owned by the
    // request fiber's scope.
    Layer.provide(
      ExecutionStackMiddleware.combine(requestScopedMiddleware(makeTestDbLive(state))).layer,
    ),
    Layer.provideMerge(HttpServer.layerServices),
  );
  return HttpRouter.toWebHandler(App, { disableLogger: true }).handler;
};

const makeStackProbeState = async (requestCount: number): Promise<StackProbeState> => {
  const pool: SqliteTestFumaDb[] = [];
  for (let index = 0; index < requestCount; index += 1) {
    pool.push(await createSqliteTestFumaDb({ tables: collectTables() }));
  }
  return {
    pool,
    handles: [],
    builds: 0,
    builtWithHandleId: [],
    lateReadOwnership: new Map(),
  };
};

describe("ExecutionStackMiddleware request scoping", () => {
  beforeEach(() => {
    // `makeExecutionStack` touches the subject once per build, behind a
    // process-local throttle. Reset it so every case does the same work.
    resetSubjectTouchCache();
  });

  it("builds the execution stack once per concurrent request", async () => {
    const state = await makeStackProbeState(3);
    const handler = makeStackProbeHandler(state);

    const responses = await Promise.all([
      handler(new Request("http://test.local/probe"), Context.empty()),
      handler(new Request("http://test.local/probe"), Context.empty()),
      handler(new Request("http://test.local/probe"), Context.empty()),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    // Three requests, three request-scoped handles, three stack builds. A lower
    // build count means some request served its work on a stack built for a
    // different request.
    expect(state.handles.length).toBe(3);
    expect(state.builds).toBe(3);
  });

  it("never builds a request's stack over another request's database handle", async () => {
    const state = await makeStackProbeState(3);
    const handler = makeStackProbeHandler(state);

    await Promise.all([
      handler(new Request("http://test.local/probe"), Context.empty()),
      handler(new Request("http://test.local/probe"), Context.empty()),
      handler(new Request("http://test.local/probe"), Context.empty()),
    ]);

    // Every acquired handle must be the one its own request's stack was built
    // over: three builds reading three distinct handles, covering all three.
    const acquired = state.handles.map((handle) => handle.id);
    expect(acquired).toEqual([1, 2, 3]);
    expect([...state.builtWithHandleId].sort()).toEqual(acquired);
    expect(new Set(state.builtWithHandleId).size).toBe(state.handles.length);
  });

  it("keeps a slow request's connection usable after a faster overlapping request ends", async () => {
    const state = await makeStackProbeState(2);
    const handler = makeStackProbeHandler(state);

    // The fast request is served first, so it acquires handle 1. It finishes
    // while the slow request is still awaiting, which is the window in which a
    // borrowed connection gets pulled out from under its borrower.
    const [fast, slow] = await Promise.all([
      handler(new Request("http://test.local/probe?delay=0"), Context.empty()),
      handler(new Request("http://test.local/probe?delay=80"), Context.empty()),
    ]);

    // Read, slow await, read again — both reads succeed for both requests.
    expect(await fast.json()).toEqual({ early: "ok", late: "ok" });
    expect(await slow.json()).toEqual({ early: "ok", late: "ok" });

    // Ownership at the read-after-await is the real assertion. The fast
    // request has ended and released its connection by then, so the slow
    // request is reading in exactly the window that breaks in production —
    // and its OWN connection is still open, because that is the one its stack
    // was built over.
    //
    // Sharing one build inverts this: the slow request's own connection is
    // released while it is still running, and it keeps reading on the fast
    // request's instead.
    const slowView = state.lateReadOwnership.get(80);
    expect(slowView?.ownClosed).toBe(false);
    expect(slowView?.otherClosed).toEqual([true]);

    // Each request built its stack over its own connection.
    expect(state.builds).toBe(2);
    expect([...state.builtWithHandleId].sort()).toEqual([1, 2]);
    expect(state.lateReadOwnership.get(0)?.ownHandleId).not.toBe(slowView?.ownHandleId);
  });
});
