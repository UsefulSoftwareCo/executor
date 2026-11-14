/**
 * The MCP transport patched in `patches/effect@4.1.4.patch` keeps at most `maxSessions` HTTP
 * sessions and never forgets one that owns work: a request in flight, or work `heldSession`
 * reports. When every session owns work, `initialize` is refused with 503 until one finishes.
 *
 * Self-host sets 256, and its programs pin at most 64 sessions, so filling every place through the
 * product takes about 190 other requests in flight at once. The probe runs the patched transport
 * in its own Node process instead, as the self-host product installs it, with a bound of 2, a tool
 * whose calls wait until the probe releases them, and a `heldSession` the probe controls. It sends
 * real HTTP requests over loopback and reports what they got.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const probe = `
import { createServer } from "node:http";
import { registerHooks } from "node:module";

// Hooks into the installed transport, read-only: the point after admission takes a session's place,
// after a request holds its session, and after a route's handler returns its response, and the
// runtime's own counts. Each must match, so a change to the transport fails the probe instead of
// silently skipping a check.
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    const hook = (pairs) => {
      let source = typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
      for (const [from, to] of pairs) {
        if (!source.includes(from)) throw new Error("probe hook did not match " + url + ": " + from);
        source = source.replace(from, to);
      }
      loaded.source = source;
    };
    const admitted = "const admission = runtime.admitHttp(request.headers, parsed, httpRequest);";
    if (url.endsWith("/effect/dist/ai/McpServer.js")) hook([
      [admitted, admitted + " globalThis.sessionBoundary?.('admitted');"],
    ]);
    const held = "holdHttp: sessionId => stateful?.holdHttp(sessionId) ?? (() => {}),";
    if (url.endsWith("/effect/dist/ai/internal/mcpRuntime.js")) hook([
      [held, "holdHttp: sessionId => { const release = stateful?.holdHttp(sessionId) ?? (() => {}); globalThis.sessionBoundary?.('held', sessionId); return release; },"],
    ]);
    const routed = "return route.handler;";
    if (url.endsWith("/effect/dist/http/HttpRouter.js")) hook([
      [routed, "return Effect.tap(route.handler, () => Effect.sync(() => globalThis.sessionBoundary?.('responded')));"],
    ]);
    const counted = "const reservations = new Set();";
    if (url.endsWith("/effect/dist/ai/internal/mcpStatefulRuntime.js")) hook([
      [counted, counted + " (globalThis.sessionRuntimes ??= []).push({ reservations, bySessionId, inFlight });"],
    ]);
    return loaded;
  },
});
const { Context, Deferred, Effect, Exit, Cause, Fiber, Layer, References, Scheduler, Schema } = await import("effect");
const { McpProtocol, McpServer, Tool, Toolkit } = await import("effect/ai");
const { HttpRouter, HttpServer } = await import("effect/http");
const NodeHttpServer = await import("@effect/platform-node/NodeHttpServer");

// A client that disconnects at one exact point: the request's fiber yields right after the hooked
// point, the client aborts, and the fiber resumes only once the server has handled the abort.
const boundary = { armed: undefined, target: undefined, stash: false, resume: undefined, abort: undefined, fiber: undefined };
// Every request that took a place or a hold, so a check can wait until those requests have ended:
// a hold ends when its request's scope closes, which can be after its client has the response.
const requests = [];
globalThis.sessionBoundary = (point, session) => {
  if (point !== "responded") requests.push({ session, fiber: Fiber.getCurrent() });
  if (boundary.armed !== point) return;
  boundary.armed = undefined;
  boundary.target = boundary.fiber = Fiber.getCurrent();
};
const boundaryScheduler = {
  executionMode: "async",
  makeDispatcher: () => {
    const dispatcher = new Scheduler.MixedScheduler().makeDispatcher();
    return {
      flush: () => dispatcher.flush(),
      scheduleTask: (task, priority) => {
        // The task a yielding fiber schedules for itself is the next one after shouldYield.
        if (!boundary.stash) return dispatcher.scheduleTask(task, priority);
        boundary.stash = false;
        boundary.resume = () => dispatcher.scheduleTask(task, priority);
      },
    };
  },
  shouldYield: (fiber) => {
    if (fiber !== boundary.target) return fiber.currentOpCount >= 2048;
    boundary.target = undefined;
    boundary.stash = true;
    queueMicrotask(boundary.abort);
    return true;
  },
};
// Registered before the transport's own listeners, so an abort's close reaches the transport first.
const createWatchedServer = () => {
  const server = createServer();
  server.on("request", (_request, response) => response.on("close", () => {
    if (response.writableEnded || boundary.resume === undefined) return;
    const resume = boundary.resume;
    boundary.resume = undefined;
    queueMicrotask(resume);
  }));
  return server;
};

const Hold = Tool.make("hold", { parameters: Schema.Struct({ key: Schema.String }), success: Schema.String });
// Sends a log notification before it waits, so its call answers with a stream.
const Announce = Tool.make("announce", { parameters: Schema.Struct({ key: Schema.String }), success: Schema.String });
const Holding = Toolkit.make(Hold, Announce);

// One transport on a loopback port, with a bound of 2 unless options give maxSessions, which may be
// undefined for no bound, for the length of run(url, control).
const withServer = (heldSession, run, options = {}) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const maxSessions = "maxSessions" in options ? options.maxSessions : 2;
  const atBoundary = options.atBoundary === true;
  const latches = new Map();
  const latch = (key) => {
    if (!latches.has(key)) latches.set(key, { entered: Deferred.makeUnsafe(), released: Deferred.makeUnsafe() });
    return latches.get(key);
  };
  const app = McpServer.toolkit(Holding).pipe(
    Layer.provide(Holding.toLayer({
      hold: ({ key }) => Deferred.succeed(latch(key).entered, undefined).pipe(
        Effect.andThen(Deferred.await(latch(key).released)),
        Effect.as("released " + key),
      ),
      announce: ({ key }) => Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        yield* server.notifications["notifications/message"]({ level: "info", data: "announce " + key });
        yield* Deferred.await(latch(key).released);
        return "released " + key;
      }),
    })),
    Layer.provide(McpServer.layerHttp({
      name: "Session bound", version: "1.0.0", path: "/mcp",
      protocols: [McpProtocol.v2025_11_25], maxSessions, heldSession,
    })),
  );
  // Requests yield to the event loop every few steps, so requests sent together are all admitted
  // before any registers its session. At the default budget each ran from admission to
  // registration before the next was read.
  const services = yield* Layer.build(HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createWatchedServer, { host: "127.0.0.1", port: 0 })),
    Layer.provide(atBoundary
      ? Layer.succeed(References.Scheduler, boundaryScheduler)
      : Layer.succeed(References.MaxOpsBeforeYield, 4)),
  ));
  const url = "http://127.0.0.1:" + Context.get(services, HttpServer.HttpServer).address.port + "/mcp";
  const control = {
    entered: (key) => Effect.runPromise(Deferred.await(latch(key).entered)),
    release: (key) => Effect.runPromise(Deferred.succeed(latch(key).released, undefined)),
  };
  return yield* Effect.promise(() => run(url, control));
})));

const post = async (url, message, session, signal) => {
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session === undefined ? {} : { "mcp-session-id": session, "mcp-protocol-version": "2025-11-25" }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
  });
  const text = await response.text();
  let code;
  try { code = JSON.parse(text).error?.code; } catch {}
  return { status: response.status, session: response.headers.get("mcp-session-id") ?? undefined,
    retryAfter: response.headers.get("retry-after") ?? undefined, code, text };
};
const initialize = (url) => post(url, { id: 1, method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "session-bound-probe", version: "1.0.0" } } });
const confirm = async (url, session) => (await post(url, { method: "notifications/initialized" }, session)).status;
const ping = async (url, session) => (await post(url, { id: 3, method: "ping" }, session)).status;
const openSession = async (url) => {
  const session = (await initialize(url)).session;
  await confirm(url, session);
  return session;
};
const refusal = ({ status, retryAfter, code }) => ({ status, retryAfter, code });
const initializeMessage = { id: 1, method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "session-bound-probe", version: "1.0.0" } } };
const finished = (fiber) => Effect.runPromise(Fiber.await(fiber));
/** Wait until every request so far has ended. */
const settle = async () => {
  for (const { fiber } of requests.splice(0)) await finished(fiber);
};
/** Wait until the last request on session has ended. */
const settled = (session) => finished(requests.findLast((request) => request.session === session).fiber);
// The runtime's own counts for the server created last, once every request so far has ended.
const counts = async () => {
  await settle();
  const runtime = globalThis.sessionRuntimes.at(-1);
  return { sessions: runtime.bySessionId.size, reserved: runtime.reservations.size, inFlight: runtime.inFlight.size };
};
// Send one request whose client disconnects at point; report what the client saw and how the
// request's fiber ended, once it has.
const abortAt = async (point, url, message, session) => {
  const controller = new AbortController();
  boundary.armed = point;
  boundary.fiber = undefined;
  boundary.abort = () => controller.abort();
  const client = await post(url, message, session, controller.signal).then(() => "answered", (error) => error.name);
  if (boundary.fiber === undefined) throw new Error("the request never reached " + point);
  const exit = await Effect.runPromise(Fiber.await(boundary.fiber));
  return { client, interrupted: Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) };
};

// Eight initialize requests sent together while every session owns work, then the work ends.
let held = true;
const together = await withServer(() => held, async (url) => {
  const answers = await Promise.all(Array.from({ length: 8 }, () => initialize(url)));
  const opened = answers.filter((answer) => answer.status === 200).map((answer) => answer.session);
  const confirmed = [];
  const pings = [];
  for (const session of opened) {
    confirmed.push(await confirm(url, session));
    pings.push(await ping(url, session));
  }
  held = false;
  await settle();
  const next = await initialize(url);
  return {
    opened: opened.length,
    refused: answers.filter((answer) => answer.status !== 200).map(refusal),
    confirmed, pings,
    next: next.status,
    afterNext: [await ping(url, opened[0]), await ping(url, opened[1]), await ping(url, next.session)],
  };
});

// Both sessions have a call in flight; then one call answers.
const inFlight = await withServer(() => false, async (url, control) => {
  const open = async () => {
    const session = (await initialize(url)).session;
    await confirm(url, session);
    return session;
  };
  const first = await open();
  const second = await open();
  const call = (session, key) => post(url, { id: 2, method: "tools/call", params: { name: "hold", arguments: { key } } }, session);
  const firstCall = call(first, "first");
  const secondCall = call(second, "second");
  await control.entered("first");
  await control.entered("second");
  const refused = [refusal(await initialize(url)), refusal(await initialize(url))];
  await control.release("first");
  const answered = await firstCall;
  await settled(first);
  const reopened = await initialize(url);
  const result = {
    refused,
    answered: { status: answered.status, released: answered.text.includes("released first") },
    reopened: reopened.status,
    first: await ping(url, first),
    second: await ping(url, second),
  };
  await control.release("second");
  result.secondReleased = (await secondCall).text.includes("released second");
  return result;
});

// Two initialize requests whose clients disconnect after admission took their places.
const abortedInitialize = await withServer(() => false, async (url) => {
  const aborted = [await abortAt("admitted", url, initializeMessage), await abortAt("admitted", url, initializeMessage)];
  const state = await counts();
  return { aborted, state, later: [(await initialize(url)).status, (await initialize(url)).status] };
}, { atBoundary: true });

// The same without a bound, as Cloud and local run the transport: three sessions then all stay open.
const abortedUnbounded = await withServer(() => false, async (url) => {
  const aborted = [await abortAt("admitted", url, initializeMessage), await abortAt("admitted", url, initializeMessage)];
  const state = await counts();
  const opened = [await openSession(url), await openSession(url), await openSession(url)];
  const pings = [];
  for (const session of opened) pings.push(await ping(url, session));
  return { aborted, state, pings };
}, { atBoundary: true, maxSessions: undefined });

// A request on each of two open sessions whose clients disconnect after the request held its session.
const abortedHold = await withServer(() => false, async (url) => {
  const sessions = [await openSession(url), await openSession(url)];
  const aborted = [];
  for (const session of sessions) aborted.push(await abortAt("held", url, { id: 3, method: "ping" }, session));
  const state = await counts();
  return { aborted, state, later: (await initialize(url)).status };
}, { atBoundary: true });

// A call on each of two open sessions that answers with a stream; each client disconnects after the
// handler returned that stream and before the server began to send it.
const abortedStream = await withServer(() => false, async (url) => {
  const sessions = [await openSession(url), await openSession(url)];
  const aborted = [];
  for (const session of sessions) {
    aborted.push(await abortAt("responded", url, { id: 2, method: "tools/call", params: { name: "announce", arguments: { key: session } } }, session));
  }
  const state = await counts();
  return { aborted, state, later: (await initialize(url)).status };
}, { atBoundary: true });

console.log(JSON.stringify({ together, inFlight, abortedInitialize, abortedUnbounded, abortedHold, abortedStream }));
`;

const Refusal = Schema.Struct({
  status: Schema.Number,
  retryAfter: Schema.optional(Schema.String),
  code: Schema.optional(Schema.Number),
});
const Aborted = Schema.Struct({ client: Schema.String, interrupted: Schema.Boolean });
const Counts = Schema.Struct({
  sessions: Schema.Number,
  reserved: Schema.Number,
  inFlight: Schema.Number,
});
const Report = Schema.Struct({
  together: Schema.Struct({
    opened: Schema.Number,
    refused: Schema.Array(Refusal),
    confirmed: Schema.Array(Schema.Number),
    pings: Schema.Array(Schema.Number),
    next: Schema.Number,
    afterNext: Schema.Array(Schema.Number),
  }),
  inFlight: Schema.Struct({
    refused: Schema.Array(Refusal),
    answered: Schema.Struct({ status: Schema.Number, released: Schema.Boolean }),
    reopened: Schema.Number,
    first: Schema.Number,
    second: Schema.Number,
    secondReleased: Schema.Boolean,
  }),
  abortedInitialize: Schema.Struct({
    aborted: Schema.Array(Aborted),
    state: Counts,
    later: Schema.Array(Schema.Number),
  }),
  abortedUnbounded: Schema.Struct({
    aborted: Schema.Array(Aborted),
    state: Counts,
    pings: Schema.Array(Schema.Number),
  }),
  abortedHold: Schema.Struct({
    aborted: Schema.Array(Aborted),
    state: Counts,
    later: Schema.Number,
  }),
  abortedStream: Schema.Struct({
    aborted: Schema.Array(Aborted),
    state: Counts,
    later: Schema.Number,
  }),
});
/** 503 with JSON-RPC error -32013 and a retry hint. */
const refused = { status: 503, retryAfter: "1", code: -32013 };

const report = Effect.gen(function* () {
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* processes.string(
    ChildProcess.make("node", ["--input-type=module", "--eval", probe]),
  );
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Report))(
    output.trim().split("\n").at(-1),
  );
}).pipe(Effect.provide(NodeServices.layer));

it.live(
  "MCP transport opens no more sessions than its bound for initialize requests admitted together, and refuses initialize while every session owns work",
  () =>
    Effect.gen(function* () {
      const { together, inFlight } = yield* report;

      // Each admission takes its session's place, so two of eight open however they interleave.
      // On the previous patch, which checked the bound at admission and registered later, all
      // eight opened.
      expect(together.opened, "sessions opened by eight initialize requests").toBe(2);
      expect(together.refused).toEqual(Array.from({ length: 6 }, () => refused));
      expect(together.confirmed).toEqual([202, 202]);
      expect(together.pings).toEqual([200, 200]);
      // Once the work ends, initialize opens again and forgets the least recently used session.
      expect(together.next).toBe(200);
      expect(together.afterNext).toEqual([404, 200, 200]);

      // A request in flight owns its session; a refused initialize takes no place.
      expect(inFlight.refused).toEqual([refused, refused]);
      expect(inFlight.answered).toEqual({ status: 200, released: true });
      // The session whose call answered owns nothing now and is the one forgotten.
      expect(inFlight.reopened).toBe(200);
      expect(inFlight.first).toBe(404);
      expect(inFlight.second).toBe(200);
      expect(inFlight.secondReleased).toBe(true);
    }),
  60_000,
);

/** Each request's client disconnected at the exact point after the acquisition, and the server interrupted the request. */
const disconnected = [
  { client: "AbortError", interrupted: true },
  { client: "AbortError", interrupted: true },
];

it.live(
  "MCP transport gives back an initialize's place when its client disconnects after admission",
  () =>
    Effect.gen(function* () {
      const { abortedInitialize, abortedUnbounded } = yield* report;
      // Leaked, the two places filled the bound of 2 and every later initialize got 503.
      expect(abortedInitialize.aborted).toEqual(disconnected);
      expect(abortedInitialize.state).toEqual({ sessions: 0, reserved: 0, inFlight: 0 });
      expect(abortedInitialize.later).toEqual([200, 200]);
      // Without a bound no place is kept at all, and three sessions stay open where 2 would forget one.
      expect(abortedUnbounded.aborted).toEqual(disconnected);
      expect(abortedUnbounded.state).toEqual({ sessions: 0, reserved: 0, inFlight: 0 });
      expect(abortedUnbounded.pings).toEqual([200, 200, 200]);
    }),
  60_000,
);

it.live(
  "MCP transport releases a session's hold when a request's client disconnects after the hold",
  () =>
    Effect.gen(function* () {
      const { abortedHold } = yield* report;
      // Leaked, both sessions owned work for good and every later initialize got 503.
      expect(abortedHold.aborted).toEqual(disconnected);
      expect(abortedHold.state).toEqual({ sessions: 2, reserved: 0, inFlight: 0 });
      expect(abortedHold.later).toBe(200);
    }),
  60_000,
);

it.live(
  "MCP transport releases a session's hold when a client disconnects after its streamed response was returned",
  () =>
    Effect.gen(function* () {
      const { abortedStream } = yield* report;
      // The handler had returned a stream and the server had not begun to send it. Leaked, both
      // sessions owned work for good and every later initialize got 503.
      expect(abortedStream.aborted).toEqual(disconnected);
      expect(abortedStream.state).toEqual({ sessions: 2, reserved: 0, inFlight: 0 });
      expect(abortedStream.later).toBe(200);
    }),
  60_000,
);
