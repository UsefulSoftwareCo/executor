import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createServer, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";

const probe = (routes: string, relay: string) => `
import { appOutboundRoutes } from ${JSON.stringify(routes)};
import { relayed } from ${JSON.stringify(relay)};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const range = (count, from = 0) => Array.from({ length: count }, (_, index) => from + index);
const settled = (sends) => Promise.all(sends.map((sent) => sent.result));
/** \`promise\`, or "still waiting" after \`ms\`. */
const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => "still waiting")]);

/** A case's own routes, and requests to the service named for the case. */
const start = (env, name) => {
  const routes = appOutboundRoutes();
  const service = (path) => env.SERVICE + path + (path.includes("?") ? "&" : "?") + "case=" + name;
  const transport = {
    direct: (request) => fetch(request),
    relay: (slot, request) => relayed(env.RELAY, slot, request),
  };
  /** Send one request of group "g"; \`route()\` is how it was sent, once it has a route. */
  const send = (request, through = transport) => {
    const sent = [];
    const result = routes.send("g", request, through, sent).then(
      async (response) => ({ ok: true, text: await response.text() }),
      (error) => ({ ok: false, error: error instanceof Error ? error.name + ": " + error.message : String(error) }),
    );
    return { result, route: () => sent[0] ?? null };
  };
  /** A request the service holds until the case answers it. */
  const held = (id, signal) => send(new Request(service("/held?id=" + id), { signal }));
  const state = async () => (await fetch(service("/state"))).json();
  /**
   * Once the service has received \`count\` of the case's held requests, or 3 s have passed: a
   * request that never arrives shows in what the case returns.
   */
  const arrived = async (count) => {
    for (let tries = 0; tries < 300; tries++) {
      const { arrived } = await state();
      if (arrived.length >= count) return;
      await sleep(10);
    }
  };
  /** Answer one held request, or all of them and every one that arrives after. */
  const answer = (id) => fetch(service("/answer" + (id === undefined ? "" : "?id=" + id))).then((response) => response.text());
  return { routes, service, send, held, state, arrived, answer };
};

const cases = {
  async lifetime(c) {
    let release = c.routes.hold("g");
    const five = range(5).map((id) => c.held(id));
    await c.arrived(5);
    // The call ends while its five requests still wait for headers. A request of the group sent
    // now, and one of a later call that holds the group again, both count against those five.
    release();
    const unheld = c.held(5);
    await c.arrived(6);
    release = c.routes.hold("g");
    const sixth = c.held(6);
    await c.arrived(7);
    await c.answer();
    await settled([...five, unheld, sixth]);
    release();
    return { five: five.map((sent) => sent.route()), unheld: unheld.route(), sixth: sixth.route() };
  },
  async throws(c) {
    const release = c.routes.hold("g");
    const fail = () => {
      throw new Error("set-up failed");
    };
    const thrown = await settled(range(5).map(() => c.send(new Request(c.service("/fast")), { direct: fail, relay: fail })));
    const five = range(5).map((id) => c.held(id));
    await c.arrived(5);
    await c.answer();
    await settled(five);
    release();
    return { thrown, five: five.map((sent) => sent.route()) };
  },
  async waiting(c) {
    const release = c.routes.hold("g");
    const five = range(5).map((id) => c.held(id));
    await c.arrived(5);
    const sixth = c.held(5);
    // Read after the sixth has started waiting: the service holds five, and it has no route yet.
    const during = (await c.state()).arrived.length;
    const routedDuring = sixth.route();
    await c.arrived(6);
    await c.answer();
    await settled([...five, sixth]);
    release();
    return { during, routedDuring, five: five.map((sent) => sent.route()), sixth: sixth.route() };
  },
  async warm(c) {
    const release = c.routes.hold("g");
    // A direct request that answers: the direct route is answering.
    const first = await c.send(new Request(c.service("/fast"))).result;
    const five = range(5).map((id) => c.held(id));
    await c.arrived(5);
    const sixth = c.held(5);
    await c.arrived(6);
    await c.answer();
    await settled([...five, sixth]);
    release();
    return { first, five: five.map((sent) => sent.route()), sixth: sixth.route() };
  },
  async cancelWaiting(c) {
    const release = c.routes.hold("g");
    const five = range(5).map((id) => c.held(id));
    await c.arrived(5);
    const controller = new AbortController();
    const sixth = c.held(5, controller.signal);
    await sleep(20);
    controller.abort();
    const outcome = await within(sixth.result, 3000);
    // Past the 500 ms it would have waited for a relay.
    await sleep(700);
    const after = (await c.state()).arrived;
    // One of the five answered frees a slot, which no cancelled waiter takes.
    await c.answer(0);
    await within(five[0].result, 3000);
    const seventh = c.held(6);
    await c.arrived(6);
    const routedSeventh = seventh.route();
    await c.answer();
    await settled([...five, seventh]);
    release();
    return { outcome, sixth: sixth.route(), after, seventh: routedSeventh };
  },
  async cancelRelayed(c) {
    const release = c.routes.hold("g");
    const five = range(5).map((id) => c.held(id));
    await c.arrived(5);
    const controller = new AbortController();
    const sixth = c.held(5, controller.signal);
    await c.arrived(6);
    controller.abort();
    const outcome = await within(sixth.result, 3000);
    let closed = [];
    for (let tries = 0; tries < 300 && !closed.includes("5"); tries++) {
      closed = (await c.state()).closed;
      if (!closed.includes("5")) await sleep(10);
    }
    await c.answer();
    await settled([...five, sixth]);
    release();
    return { outcome, sixth: sixth.route(), closed };
  },
  async cap(c) {
    const release = c.routes.hold("g");
    const five = range(5).map((id) => c.held(id));
    await c.arrived(5);
    const relayedSends = range(50, 5).map((id) => c.held(id));
    await c.arrived(55);
    const extra = c.held(55);
    // Past the 500 ms it would wait for a relay if there were room.
    await sleep(700);
    const during = { arrived: (await c.state()).arrived.length, route: extra.route() };
    // One relayed request answered makes room for it.
    await c.answer(5);
    await within(relayedSends[0].result, 3000);
    await c.arrived(56);
    const routedExtra = extra.route();
    await c.answer();
    await settled([...five, ...relayedSends, extra]);
    release();
    return {
      relayed: relayedSends.map((sent) => sent.route()?.route ?? null),
      during,
      extra: routedExtra,
    };
  },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const name = url.searchParams.get("case");
    const run = cases[name];
    if (run === undefined) return new Response("No case " + name, { status: 404 });
    return Response.json(await run(start(env, name)));
  },
};
`;

const config = (port: number, service: string) => `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .probe),
    (name = "relay", worker = .relay),
    (name = "loopback", network = (allow = ["public", "private", "local"])),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ],
);
const probe :Workerd.Worker = (
  modules = [ (name = "probe.js", esModule = embed "probe.js") ],
  compatibilityDate = "2026-09-08",
  globalOutbound = "loopback",
  bindings = [
    (name = "SERVICE", text = "${service}"),
    (name = "RELAY", durableObjectNamespace = (className = "AppOutboundRelay", serviceName = "relay")),
  ],
);
const relay :Workerd.Worker = (
  modules = [ (name = "relay.js", esModule = embed "relay.js") ],
  compatibilityDate = "2026-09-08",
  globalOutbound = "loopback",
  durableObjectNamespaces = [ (className = "AppOutboundRelay", uniqueKey = "outbound-routes-relay") ],
  durableObjectStorage = (inMemory = void),
);
`;

const service = Effect.acquireRelease(
  Effect.callback<{ readonly origin: string; readonly close: () => void }>((resume) => {
    const cases = new Map<
      string,
      {
        arrived: Array<string>;
        closed: Array<string>;
        held: Map<string, ServerResponse>;
        answered: boolean;
      }
    >();
    const of = (name: string) => {
      const found = cases.get(name);
      if (found !== undefined) return found;
      const created = {
        arrived: [],
        closed: [],
        held: new Map<string, ServerResponse>(),
        answered: false,
      };
      cases.set(name, created);
      return created;
    };
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://service");
      const state = of(url.searchParams.get("case") ?? "");
      const id = url.searchParams.get("id");
      if (url.pathname === "/held" && id !== null) {
        state.arrived.push(id);
        if (state.answered) {
          response.end("answered");
          return;
        }
        state.held.set(id, response);
        response.on("close", () => {
          if (!response.writableEnded) state.closed.push(id);
          state.held.delete(id);
        });
        return;
      }
      if (url.pathname === "/answer") {
        if (id === null) state.answered = true;
        for (const [heldId, held] of state.held)
          if (id === null || id === heldId) {
            held.end("answered");
            state.held.delete(heldId);
          }
        response.end("answered");
        return;
      }
      if (url.pathname === "/state") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ arrived: state.arrived, closed: state.closed }));
        return;
      }
      response.end("fast");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No TCP address");
      resume(
        Effect.succeed({
          origin: `http://127.0.0.1:${address.port}`,
          close: () => {
            server.closeAllConnections();
            server.close();
          },
        }),
      );
    });
  }),
  (opened) => Effect.sync(() => opened.close()),
);

const freePort = Effect.callback<number>((resume) => {
  const server = createNetServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No TCP address");
    server.close(() => resume(Effect.succeed(address.port)));
  });
});

const Sent = Schema.Struct({
  route: Schema.Literals(["direct", "relay"]),
  wait_ms: Schema.Number,
  headers_ms: Schema.optional(Schema.Number),
});
const Routed = Schema.NullOr(Sent);
const Outcome = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), text: Schema.String }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
  Schema.Literal("still waiting"),
]);
const Results = Schema.Struct({
  lifetime: Schema.Struct({ five: Schema.Array(Routed), unheld: Routed, sixth: Routed }),
  throws: Schema.Struct({ thrown: Schema.Array(Outcome), five: Schema.Array(Routed) }),
  waiting: Schema.Struct({
    during: Schema.Number,
    routedDuring: Routed,
    five: Schema.Array(Routed),
    sixth: Routed,
  }),
  warm: Schema.Struct({ first: Outcome, five: Schema.Array(Routed), sixth: Routed }),
  cancelWaiting: Schema.Struct({
    outcome: Outcome,
    sixth: Routed,
    after: Schema.Array(Schema.String),
    seventh: Routed,
  }),
  cancelRelayed: Schema.Struct({
    outcome: Outcome,
    sixth: Routed,
    closed: Schema.Array(Schema.String),
  }),
  cap: Schema.Struct({
    relayed: Schema.Array(Schema.NullOr(Schema.String)),
    during: Schema.Struct({ arrived: Schema.Number, route: Routed }),
    extra: Routed,
  }),
});

it.live(
  "Cloud's outbound routes count, wait, relay, cancel and release app requests as the rule says",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = path.resolve(".local/outbound-routes");
      yield* fs.makeDirectory(directory, { recursive: true });
      const implementation = path.resolve("apps/hosted/cloud/src/implementation");
      const relayModule = path.join(implementation, "app-outbound-relay.ts");
      yield* fs.writeFileString(
        path.join(directory, "probe.ts"),
        probe(path.join(implementation, "app-outbound-routes.ts"), relayModule),
      );
      const built = yield* processes.exitCode(
        ChildProcess.make(
          "bun",
          [
            "build",
            path.join(directory, "probe.ts"),
            "--target=browser",
            "--format=esm",
            "--external=cloudflare:*",
            `--outfile=${path.join(directory, "probe.js")}`,
          ],
          { stdout: "inherit", stderr: "inherit" },
        ),
      );
      expect(built, "The probe bundles").toBe(0);
      yield* fs.writeFileString(
        path.join(directory, "relay-script.ts"),
        `import { relayScript } from ${JSON.stringify(relayModule)};
await Bun.write(${JSON.stringify(path.join(directory, "relay.js"))}, relayScript);
`,
      );
      const written = yield* processes.exitCode(
        ChildProcess.make("bun", [path.join(directory, "relay-script.ts")], {
          stdout: "inherit",
          stderr: "inherit",
        }),
      );
      expect(written, "The relay's code is written").toBe(0);

      const upstream = yield* service;
      const port = yield* freePort;
      yield* fs.writeFileString(
        path.join(directory, "config.capnp"),
        config(port, upstream.origin),
      );
      yield* processes.spawn(
        ChildProcess.make(
          "node_modules/.bin/workerd",
          ["serve", path.join(directory, "config.capnp")],
          { stdout: "inherit", stderr: "inherit" },
        ),
      );
      const origin = `http://127.0.0.1:${port}`;
      const http = yield* HttpClient.HttpClient;
      const text = (url: string) =>
        Effect.scoped(http.get(url).pipe(Effect.flatMap((response) => response.text)));
      yield* text(`${origin}/health`).pipe(
        Effect.retry({ times: 100, schedule: Schedule.spaced("100 millis") }),
      );
      const names = [
        "lifetime",
        "throws",
        "waiting",
        "warm",
        "cancelWaiting",
        "cancelRelayed",
        "cap",
      ] as const;
      const answers: Record<string, unknown> = {};
      for (const name of names)
        answers[name] = JSON.parse(yield* text(`${origin}/?case=${name}`)) as unknown;
      const results = Schema.decodeUnknownSync(Results)(answers);
      const direct = { route: "direct", wait_ms: 0 };

      expect
        .soft(results.lifetime.five, "lifetime: five go direct")
        .toMatchObject(Array.from({ length: 5 }, () => direct));
      expect
        .soft(results.lifetime.unheld, "lifetime: a request sent once no call holds it relays")
        .toMatchObject({ route: "relay" });
      expect
        .soft(results.lifetime.unheld?.wait_ms, "lifetime: that request waited")
        .toBeGreaterThanOrEqual(500);
      expect
        .soft(results.lifetime.sixth, "lifetime: the later call's request relays")
        .toMatchObject({ route: "relay" });
      expect
        .soft(results.lifetime.sixth?.wait_ms, "lifetime: the later call's request waited")
        .toBeGreaterThanOrEqual(500);
      expect
        .soft(results.throws.thrown, "throws: each send fails with its own error")
        .toEqual(Array.from({ length: 5 }, () => ({ ok: false, error: "Error: set-up failed" })));
      expect
        .soft(results.throws.five, "throws: their slots are free again")
        .toMatchObject(Array.from({ length: 5 }, () => direct));
      expect
        .soft(results.waiting.five, "waiting: five go direct")
        .toMatchObject(Array.from({ length: 5 }, () => direct));
      expect
        .soft(
          { during: results.waiting.during, route: results.waiting.routedDuring },
          "waiting: the sixth is not sent while it waits",
        )
        .toEqual({ during: 5, route: null });
      expect.soft(results.waiting.sixth?.route, "waiting: the sixth relays").toBe("relay");
      expect
        .soft(results.waiting.sixth?.wait_ms, "waiting: it waits the longer wait while cold")
        .toBeGreaterThanOrEqual(500);
      expect.soft(results.warm.first, "warm: the first request answers").toEqual({
        ok: true,
        text: "fast",
      });
      expect
        .soft(results.warm.five, "warm: five go direct")
        .toMatchObject(Array.from({ length: 5 }, () => direct));
      expect.soft(results.warm.sixth?.route, "warm: the sixth relays").toBe("relay");
      expect
        .soft(results.warm.sixth?.wait_ms, "warm: it waits at least 50 ms")
        .toBeGreaterThanOrEqual(50);
      expect
        .soft(results.warm.sixth?.wait_ms, "warm: it relays sooner than the cold wait")
        .toBeLessThan(500);
      expect
        .soft(results.cancelWaiting.outcome, "cancelWaiting: it fails as cancelled")
        .toMatchObject({ ok: false, error: expect.stringMatching(/^AbortError/u) });
      expect.soft(results.cancelWaiting.sixth, "cancelWaiting: it never takes a route").toBeNull();
      expect
        .soft(results.cancelWaiting.after, "cancelWaiting: it never reaches the service")
        .toEqual(["0", "1", "2", "3", "4"]);
      expect
        .soft(results.cancelWaiting.seventh, "cancelWaiting: the freed slot goes to the next")
        .toMatchObject(direct);
      expect
        .soft(results.cancelRelayed.sixth, "cancelRelayed: it was relayed")
        .toMatchObject({ route: "relay" });
      expect
        .soft(results.cancelRelayed.outcome, "cancelRelayed: it fails as cancelled")
        .toMatchObject({ ok: false });
      expect
        .soft(results.cancelRelayed.closed, "cancelRelayed: its connection closes")
        .toEqual(["5"]);
      expect
        .soft(results.cap.relayed, "cap: fifty relay")
        .toEqual(Array.from({ length: 50 }, () => "relay"));
      expect
        .soft(results.cap.during, "cap: the 51st waits, unsent")
        .toEqual({ arrived: 55, route: null });
      expect
        .soft(results.cap.extra, "cap: it relays once one relayed request is answered")
        .toMatchObject({ route: "relay" });
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
  120_000,
);
