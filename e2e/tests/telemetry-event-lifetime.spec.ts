import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, FileSystem, Path, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createNetServer } from "node:net";

const probe = (isolate: string) => `
import { DurableObject, waitUntil } from "cloudflare:workers";
import { Effect, Layer, Scope } from "effect";
import { isolateTelemetry } from ${JSON.stringify(isolate)};

/** Each group's exporters, and whether its current request keeps its event alive for the timer. */
const groups = new Map();
const exporters = (collector, group) => {
  const found = groups.get(group);
  if (found !== undefined) return found;
  const built = {
    keep: false,
    // Calls of the keepAlive hook: one for each timer the exporters started.
    calls: 0,
    layer: Effect.runPromise(
      isolateTelemetry(
        {
          service: "telemetry-lifetime-probe",
          version: "0",
          environment: "probe",
          clock: "cloudflare-io",
          traces: { url: collector + "/v1/traces" },
        },
        // The runtime's waitUntil as the keepAlive hook, or none.
        (work) => {
          built.calls += 1;
          if (built.keep) waitUntil(work);
        },
      ),
    ),
  };
  groups.set(group, built);
  return built;
};

async function run(env, url) {
  const id = url.searchParams.get("id");
  const group = exporters(env.COLLECTOR, url.searchParams.get("group"));
  const layer = await group.layer;
  group.keep = url.searchParams.get("keep") === "yes";
  // Never closed: the case's request ends with only the timer left to export its span.
  const scope = Effect.runSync(Scope.make());
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
  await Effect.runPromise(Effect.provideContext(Effect.withSpan(Effect.void, "probe " + id), context));
  const mode = url.searchParams.get("mode");
  if (mode === "pair") {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await Effect.runPromise(
      Effect.provideContext(Effect.withSpan(Effect.void, "probe " + id + "-second"), context),
    );
  }
  await new Promise((resolve) => setTimeout(resolve, mode === "timer" ? 100 : mode === "pair" ? 2200 : 2500));
  return new Response("answered " + id);
}

export class Probe extends DurableObject {
  fetch(request) {
    return run(this.env, new URL(request.url));
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/calls") return new Response(String(groups.get(url.searchParams.get("group"))?.calls ?? 0));
    if (url.searchParams.get("in") === "object") return env.PROBE.get(env.PROBE.idFromName(url.searchParams.get("id"))).fetch(request);
    return run(env, url);
  },
};
`;

const config = (
  port: number,
  collector: string,
) => `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .probe),
    (name = "loopback", network = (allow = ["public", "private", "local"])),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ],
);
const probe :Workerd.Worker = (
  modules = [ (name = "probe.js", esModule = embed "probe.js") ],
  compatibilityDate = "2026-09-08",
  compatibilityFlags = ["nodejs_compat"],
  globalOutbound = "loopback",
  bindings = [
    (name = "COLLECTOR", text = "${collector}"),
    (name = "PROBE", durableObjectNamespace = "Probe"),
  ],
  durableObjectNamespaces = [ (className = "Probe", uniqueKey = "telemetry-lifetime-probe") ],
  durableObjectStorage = (inMemory = void),
);
`;

const TraceExport = Schema.fromJsonString(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        scopeSpans: Schema.Array(
          Schema.Struct({ spans: Schema.Array(Schema.Struct({ name: Schema.String })) }),
        ),
      }),
    ),
  }),
);

type Outcome = "delivered" | "held" | "abandoned";

const collector = Effect.acquireRelease(
  Effect.callback<{
    readonly origin: string;
    readonly outcomes: Map<string, Array<Outcome>>;
    readonly hold: (id: string) => void;
    readonly release: (id: string) => void;
    readonly close: () => void;
  }>((resume) => {
    const outcomes = new Map<string, Array<Outcome>>();
    const held = new Map<string, Array<() => void>>();
    const holding = new Set<string>();
    const record = (id: string, index: number, outcome: Outcome) => {
      const list = outcomes.get(id) ?? [];
      list[index] = outcome;
      outcomes.set(id, list);
    };
    const read = (request: IncomingMessage) =>
      new Promise<string>((done) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => done(body));
      });
    const server = createServer((request, response) => {
      void read(request).then((body) => {
        const decoded = Schema.decodeUnknownOption(TraceExport)(body);
        const ids =
          decoded._tag === "None"
            ? []
            : decoded.value.resourceSpans.flatMap((resource) =>
                resource.scopeSpans.flatMap((scope) =>
                  scope.spans.flatMap((span) =>
                    span.name.startsWith("probe ") ? [span.name.slice("probe ".length)] : [],
                  ),
                ),
              );
        const heldId = ids.find((id) => holding.has(id));
        if (heldId === undefined) {
          for (const id of ids) record(id, outcomes.get(id)?.length ?? 0, "delivered");
          response.end("{}");
          return;
        }
        const index = outcomes.get(heldId)?.length ?? 0;
        record(heldId, index, "held");
        let answered = false;
        let abandoned = false;
        response.on("close", () => {
          if (answered) return;
          abandoned = true;
          record(heldId, index, "abandoned");
        });
        held.set(heldId, [
          ...(held.get(heldId) ?? []),
          () => {
            if (abandoned) return;
            answered = true;
            record(heldId, index, "delivered");
            response.end("{}");
          },
        ]);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No TCP address");
      resume(
        Effect.succeed({
          origin: `http://127.0.0.1:${address.port}`,
          outcomes,
          hold: (id: string) => holding.add(id),
          release: (id: string) => {
            holding.delete(id);
            for (const answer of held.get(id) ?? []) answer();
            held.delete(id);
          },
          close: () => server.close(),
        }),
      );
    });
  }),
  (collector) => Effect.sync(() => collector.close()),
);

const freePort = Effect.callback<number>((resume) => {
  const server = createNetServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No TCP address");
    server.close(() => resume(Effect.succeed(address.port)));
  });
});

it.live(
  "the isolate flush keeps a Worker event alive until its timer has exported, and a Durable Object needs no help",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = path.resolve(".local/telemetry-event-lifetime");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "probe.ts"),
        probe(path.resolve("packages/telemetry/src/isolate.ts")),
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
            "--external=node:*",
            `--outfile=${path.join(directory, "probe.js")}`,
          ],
          { stdout: "inherit", stderr: "inherit" },
        ),
      );
      expect(built, "The probe bundles").toBe(0);

      const sink = yield* collector;
      const port = yield* freePort;
      yield* fs.writeFileString(path.join(directory, "config.capnp"), config(port, sink.origin));
      yield* processes.spawn(
        ChildProcess.make(
          "node_modules/.bin/workerd",
          ["serve", path.join(directory, "config.capnp")],
          {
            stdout: "inherit",
            stderr: "inherit",
          },
        ),
      );
      const origin = `http://127.0.0.1:${port}`;
      const http = yield* HttpClient.HttpClient;
      const text = (url: string) =>
        Effect.scoped(http.get(url).pipe(Effect.flatMap((response) => response.text)));
      yield* text(`${origin}/health`).pipe(
        Effect.retry({ times: 100, schedule: Schedule.spaced("100 millis") }),
      );

      const request = (input: {
        in: "worker" | "object";
        mode: "timer" | "post" | "pair";
        keep: boolean;
        id?: string;
        group?: string;
      }) =>
        Effect.gen(function* () {
          const id = input.id ?? `${input.in}-${input.mode}-${input.keep ? "kept" : "unkept"}`;
          const url = new URL(origin);
          url.searchParams.set("id", id);
          url.searchParams.set("group", input.group ?? id);
          url.searchParams.set("in", input.in);
          url.searchParams.set("mode", input.mode);
          url.searchParams.set("keep", input.keep ? "yes" : "no");
          if (input.mode === "post") sink.hold(id);
          const answer = yield* text(url.href);
          expect(answer).toBe(`answered ${id}`);
          return id;
        });
      const outcomes = (id: string) => [...(sink.outcomes.get(id) ?? [])];

      const timer = (where: "worker" | "object", keep: boolean) =>
        Effect.gen(function* () {
          const id = yield* request({ in: where, mode: "timer", keep });
          yield* Effect.sleep("2500 millis");
          return outcomes(id);
        });
      const post = (where: "worker" | "object", keep: boolean) =>
        Effect.gen(function* () {
          const id = yield* request({ in: where, mode: "post", keep });
          yield* Effect.sleep("1 second");
          const meanwhile = outcomes(id);
          sink.release(id);
          yield* Effect.sleep("1 second");
          return { meanwhile, after: outcomes(id) };
        });

      const stale = yield* Effect.gen(function* () {
        const first = yield* request({
          in: "worker",
          mode: "timer",
          keep: false,
          id: "stale-first",
          group: "stale",
        });
        yield* Effect.sleep("7 seconds");
        const second = yield* request({
          in: "worker",
          mode: "timer",
          keep: true,
          id: "stale-second",
          group: "stale",
        });
        yield* Effect.sleep("2500 millis");
        return { first: outcomes(first), second: outcomes(second) };
      }).pipe(Effect.forkChild);

      const results = {
        workerTimerUnkept: yield* timer("worker", false),
        workerTimerKept: yield* timer("worker", true),
        workerPostUnkept: yield* post("worker", false),
        workerPostKept: yield* post("worker", true),
        objectTimerUnkept: yield* timer("object", false),
        objectTimerKept: yield* timer("object", true),
        objectPostUnkept: yield* post("object", false),
        objectPostKept: yield* post("object", true),
        stale: yield* Fiber.join(stale),
        pair: yield* Effect.gen(function* () {
          const id = yield* request({ in: "worker", mode: "pair", keep: true, id: "pair" });
          const calls = yield* text(`${origin}/calls?group=${id}`);
          return { calls, first: outcomes(id), second: outcomes(`${id}-second`) };
        }),
      };

      expect.soft(results.workerTimerUnkept, "A Worker's unkept timer never exports").toEqual([]);
      expect.soft(results.workerTimerKept, "A Worker's kept timer exports").toEqual(["delivered"]);
      expect
        .soft(results.workerPostUnkept, "A Worker's unkept export is cut off and lost")
        .toEqual({
          meanwhile: ["abandoned"],
          after: ["abandoned"],
        });
      expect.soft(results.workerPostKept, "A Worker's kept export stays open and arrives").toEqual({
        meanwhile: ["held"],
        after: ["delivered"],
      });
      expect
        .soft(results.pair, "An item buffered while a timer is armed starts no second timer")
        .toEqual({ calls: "1", first: ["delivered"], second: ["delivered"] });
      expect
        .soft(results.stale, "A stale timer is replaced, and both spans leave")
        .toEqual({ first: ["delivered"], second: ["delivered"] });
      for (const [name, outcome] of [
        ["objectTimerUnkept", results.objectTimerUnkept],
        ["objectTimerKept", results.objectTimerKept],
      ] as const)
        expect.soft(outcome, name).toEqual(["delivered"]);
      for (const [name, outcome] of [
        ["objectPostUnkept", results.objectPostUnkept],
        ["objectPostKept", results.objectPostKept],
      ] as const)
        expect.soft(outcome, name).toEqual({ meanwhile: ["held"], after: ["delivered"] });
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
  90_000,
);
