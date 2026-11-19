/** Telemetry ingest through the packaged Go/workerd host never stalls product requests. */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { Effect, Fiber, FileSystem, Schedule, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { appsManifest } from "../support/apps-release.ts";
import { collectorRequest, nativeSelfHost } from "../support/native-self-host.ts";
import { lockedNpmRegistry } from "../support/npm-registry.ts";
import { driver } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });

/** One export near the collector's 16 MiB limit: traces of 40 spans with statement-sized tags. */
const traceExport = (spans: number) => {
  const now = BigInt(Date.now()) * 1_000_000n;
  let traceId = hex(16);
  let rootId = hex(8);
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [attribute("service.name", "synthetic-load")] },
        scopeSpans: [
          {
            scope: { name: "synthetic" },
            spans: Array.from({ length: spans }, (_, index) => {
              if (index % 40 === 0) {
                traceId = hex(16);
                rootId = hex(8);
              }
              return {
                traceId,
                spanId: index % 40 === 0 ? rootId : hex(8),
                ...(index % 40 === 0 ? {} : { parentSpanId: rootId }),
                name: ["sql.execute", "storage.query", "http.server POST"][index % 3],
                kind: 1,
                startTimeUnixNano: String(now - 5_000_000n),
                endTimeUnixNano: String(now),
                attributes: [
                  attribute(
                    "db.query.text",
                    `select "id" from "records" where "id" = $1 -- ${hex(32)}`,
                  ),
                  attribute("synthetic.record.id", hex(20)),
                  attribute("synthetic.payload", hex(200)),
                ],
                status: { code: 1 },
              };
            }),
          },
        ],
      },
    ],
  });
};

const Ingested = Schema.Struct({ insertedSpans: Schema.Number });
const DeliveredSpans = Schema.Struct({
  data: Schema.Array(Schema.Struct({ span: Schema.Struct({ serviceName: Schema.String }) })),
});

const collectorReady = (socket: string) =>
  collectorRequest(socket, "/api/health").pipe(
    Effect.flatMap(({ status }) =>
      status === 200 ? Effect.void : Effect.fail("The collector is starting"),
    ),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
  );

const productHealth = (origin: string) =>
  driver("product health", () => {
    const started = performance.now();
    return fetch(`${origin}/health`).then((response) =>
      response
        .arrayBuffer()
        .then(() => ({ status: response.status, latency: performance.now() - started })),
    );
  });

/** Sends a traced product request and waits for its spans to reach the collector. */
const deliveredProductTrace = (origin: string, socket: string) =>
  Effect.gen(function* () {
    const traceId = hex(16);
    const metadata = yield* driver("traced product request", () =>
      fetch(`${origin}/.well-known/oauth-authorization-server`, {
        headers: { traceparent: `00-${traceId}-${hex(8)}-01` },
      }),
    );
    expect(metadata.status).toBe(200);
    yield* productSpans(socket, traceId).pipe(
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
    );
    return traceId;
  });

const productSpans = (socket: string, traceId: string) =>
  Effect.gen(function* () {
    const response = yield* collectorRequest(socket, `/api/traces/${traceId}/spans`);
    if (response.status !== 200)
      return yield* Effect.fail(`The collector answered ${response.status}`);
    const trace = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DeliveredSpans))(
      response.text,
    ).pipe(Effect.mapError((error) => String(error)));
    if (!trace.data.some(({ span }) => span.serviceName === "executor-selfhost"))
      return yield* Effect.fail("The product span has not reached the collector");
    return trace;
  });

it.live(scenarios.selfHostNativeTelemetry.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* nativeSelfHost({});
      const exports = 3;
      const spans = 12_000;
      const body = traceExport(spans);
      expect(Buffer.byteLength(body)).toBeLessThan(16 * 1024 * 1024);
      yield* collectorReady(host.collectorSocket);
      let exporting = true;
      const health: number[] = [];
      const poll = yield* Effect.whileLoop({
        while: () => exporting,
        body: () =>
          productHealth(host.origin).pipe(
            Effect.tap(({ status }) =>
              status === 200 ? Effect.void : Effect.fail(`Product health returned ${status}`),
            ),
            Effect.tap(() => Effect.sleep("25 millis")),
          ),
        step: ({ latency }) => health.push(latency),
      }).pipe(Effect.forkScoped);
      const inserted = yield* Effect.forEach(
        Array.from({ length: exports }),
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const response = yield* collectorRequest(host.collectorSocket, "/v1/traces", body);
              // The collector explains a refused export in its body, such as a full ingest queue.
              expect(response.status, response.text.slice(0, 500)).toBe(200);
              const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Ingested))(
                response.text,
              );
              return result.insertedSpans;
            }),
          ),
        { concurrency: 1 },
      );
      // A health request that waited behind the last export completes just after it.
      yield* Effect.sleep("250 millis");
      exporting = false;
      // Joining, not interrupting, fails the scenario on any failed or non-200 health request.
      yield* Fiber.join(poll).pipe(Effect.timeout("1 second"));
      expect(inserted).toEqual(Array.from({ length: exports }, () => spans));
      expect(health.length).toBeGreaterThan(0);
      // Storing each export holds the collector's thread for about a second or more. Product
      // requests must not wait behind it.
      expect(Math.max(...health)).toBeLessThan(750);

      // The product still delivers its own spans to the collector in the other process.
      yield* deliveredProductTrace(host.origin, host.collectorSocket);
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live(scenarios.selfHostNativeTelemetryLifecycle.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const host = yield* nativeSelfHost({});
      // The collector's command line names this fixture's motel directory. The capnp it serves
      // lives in the host's temporary directory, not under the shared runtime. pgrep -f is an
      // extended regex, and a pattern that starts with `-` is an option, so the flag is escaped
      // and passed after `--`. A missing pgrep fails the scenario; no match is an empty list.
      const collectors = processes
        .lines(
          ChildProcess.make("pgrep", [
            "-f",
            "--",
            `--data=${host.motelDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
          ]),
        )
        .pipe(Effect.map((lines) => lines.filter((line) => line.trim() !== "").map(Number)));
      const onlyCollector = collectors.pipe(
        Effect.flatMap(([pid, ...others]) =>
          pid !== undefined && others.length === 0
            ? Effect.succeed(pid)
            : Effect.fail(`Expected one collector process, found ${[pid, ...others].join(", ")}`),
        ),
      );
      yield* collectorReady(host.collectorSocket);
      const retained = yield* deliveredProductTrace(host.origin, host.collectorSocket);
      const crashed = yield* onlyCollector;

      // A crashed collector never takes the product down. The supervisor waits one second, then
      // doubles up to 30s, and restarts on the same store.
      yield* Effect.sync(() => process.kill(crashed, "SIGKILL"));
      const exitedAt = yield* collectors.pipe(
        Effect.flatMap((pids) =>
          pids.includes(crashed)
            ? Effect.fail("The collector is still exiting")
            : Effect.succeed(performance.now()),
        ),
        Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 40 }),
      );
      yield* Effect.sleep("400 millis");
      expect(yield* collectors, "the 1s restart backoff has not elapsed").toEqual([]);
      expect((yield* productHealth(host.origin)).status).toBe(200);
      yield* collectorReady(host.collectorSocket);
      const restarted = yield* onlyCollector;
      expect(restarted).not.toBe(crashed);
      expect(
        performance.now() - exitedAt,
        "restart waits out the 1s backoff",
      ).toBeGreaterThanOrEqual(900);
      yield* productSpans(host.collectorSocket, retained);

      // An unfinished request keeps the product draining after a stop signal.
      const held = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const pending = request(`${host.origin}/api/auth/oauth2/register`, {
            method: "POST",
            headers: { "content-type": "application/json", "content-length": "100000" },
          });
          pending.on("error", () => {});
          pending.write("{");
          return pending;
        }),
        (pending) => Effect.sync(() => pending.destroy()),
      );
      yield* Effect.sleep("500 millis");
      // Ctrl-C in a terminal signals the collector and the host together. The host stops the
      // supervisor immediately, so the collector stays down through the product drain, past the
      // one-second restart backoff.
      const signalled = performance.now();
      yield* Effect.sync(() => {
        process.kill(restarted, "SIGINT");
        process.kill(host.pid, "SIGINT");
      });
      yield* Effect.sleep("3500 millis");
      expect(yield* host.isRunning, "the product is still draining its request").toBe(true);
      expect(yield* collectors).toEqual([]);
      held.destroy();
      yield* host.exitCode.pipe(Effect.timeout("15 seconds"));
      expect(performance.now() - signalled, "the host's single stop deadline").toBeLessThan(15_000);
      expect(yield* collectors).toEqual([]);
      const refused = yield* collectorRequest(host.collectorSocket, "/api/health").pipe(
        Effect.as(false),
        Effect.orElseSucceed(() => true),
      );
      expect(refused, "the collector socket is closed after shutdown").toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

type NativeRequest = {
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: object;
};

/** Dial the fixture listener directly, including when the app has a different Host. */
const nativeRequest = (origin: string, options: NativeRequest) => {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return request(new URL(options.path, origin), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...options.headers,
      ...(body === undefined
        ? {}
        : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
    },
  }).end(body);
};

const nativeReply = (origin: string, options: NativeRequest) =>
  driver(
    `${options.body === undefined ? "GET" : "POST"} ${new URL(options.path, origin).pathname}`,
    () =>
      new Promise<{ response: import("node:http").IncomingMessage; text: string }>(
        (resolve, reject) => {
          nativeRequest(origin, options)
            .once("error", reject)
            .once("response", (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.once("error", reject);
              response.once("end", () =>
                resolve({ response, text: Buffer.concat(chunks).toString("utf8") }),
              );
            });
        },
      ),
  );

const sessionCookies = (headers: import("node:http").IncomingHttpHeaders) =>
  (headers["set-cookie"] ?? []).map((cookie) => cookie.split(";")[0]).join("; ");

const streamEvent = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const liveStream = (
  origin: string,
  options: NativeRequest,
  firstFrame: (text: string) => boolean,
) =>
  Effect.gen(function* () {
    const stream = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const outgoing = nativeRequest(origin, options);
        const ready = streamEvent<string>();
        const finished = streamEvent<void>();
        let ended = false;
        outgoing.once("error", (error) => {
          ready.resolve(String(error));
          ended = true;
          finished.resolve();
        });
        outgoing.once("response", (response) => {
          const media = response.headers["content-type"]?.split(";")[0];
          if (response.statusCode !== 200 || media !== "text/event-stream") {
            ready.resolve(`expected event stream, got ${response.statusCode} ${media}`);
            response.resume();
          } else {
            let text = "";
            response.setEncoding("utf8");
            const received = (chunk: string) => {
              text += chunk;
              if (firstFrame(text)) {
                ready.resolve("open");
                response.off("data", received);
                response.resume();
              }
            };
            response.on("data", received);
          }
          response.once("error", () => {});
          response.once("close", () => {
            ended = true;
            ready.resolve("stream closed before its first frame");
            finished.resolve();
          });
        });
        return { outgoing, ready: ready.promise, finished: finished.promise, ended: () => ended };
      }),
      ({ outgoing }) => Effect.sync(() => outgoing.destroy()),
    );
    const ready = yield* driver("wait for a stream frame", () => stream.ready).pipe(
      Effect.timeout("10 seconds"),
    );
    expect(ready, options.path).toBe("open");
    return stream;
  });

it.live(scenarios.selfHostNativeGracefulShutdown.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const registry = yield* lockedNpmRegistry;
      const host = yield* nativeSelfHost({ EXECUTOR_NPM_REGISTRY: `${registry.url}/` });
      const send = (options: NativeRequest) => nativeReply(host.origin, options);
      const json = <S extends Schema.Top>(
        schema: S,
        reply: Effect.Success<ReturnType<typeof send>>,
      ) => {
        expect(reply.response.statusCode).toBe(200);
        return Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(reply.text);
      };
      const setup = yield* send({
        path: "/api/auth/self-host/setup",
        headers: { origin: host.origin },
        body: {
          name: "Shutdown Owner",
          email: "shutdown@example.test",
          password: "Synthetic-shutdown-password-123!",
          organizationName: "Shutdown lab",
        },
      });
      expect(setup.response.statusCode).toBe(200);
      const owner = { origin: host.origin, cookie: sessionCookies(setup.response.headers) };
      const [organization] = yield* json(
        Schema.NonEmptyArray(Schema.Struct({ id: Schema.String })),
        yield* send({ path: "/api/auth/organization/list", headers: owner }),
      );
      const key = yield* json(
        Schema.Struct({ key: Schema.String }),
        yield* send({
          path: "/api/auth/api-key/create",
          headers: owner,
          body: { name: "Shutdown MCP" },
        }),
      );
      const apps = `/api/organizations/${organization.id}/apps`;
      const app = yield* json(
        Schema.Struct({ id: Schema.String }),
        yield* send({
          path: `${apps}/deploy`,
          headers: owner,
          body: {
            name: "Shutdown subscription",
            files: [
              appsManifest,
              {
                path: "index.ts",
                content: `import { defineApp, number, object, query, router } from "apps";
export const latest = query({ input: object({}), output: object({ count: number() }) }, async ({ sql }) =>
  sql.exec("SELECT COUNT(*) AS count FROM notes").one() as { count: number });
export default defineApp({}, { tools: router({ latest }) });`,
              },
              {
                path: "migrations/0001_notes.sql",
                content: "CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL);\n",
              },
              {
                path: "ui/index.html",
                content:
                  "<!doctype html><html><head><title>Shutdown</title></head><body></body></html>",
              },
            ],
          },
        }),
      );
      const appHost = yield* send({ path: `${apps}/${app.id}/ui`, headers: owner }).pipe(
        Effect.flatMap((reply) =>
          json(Schema.Struct({ status: Schema.String, url: Schema.NullOr(Schema.String) }), reply),
        ),
        Effect.flatMap(({ status, url }) =>
          status === "ready" && url !== null
            ? Effect.succeed(new URL(url).host)
            : Effect.fail("The app address is not ready"),
        ),
        Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
      );
      const navigation = { accept: "text/html", "sec-fetch-mode": "navigate" };
      const redirectPath = (location: string | undefined) => {
        const url = new URL(location ?? "", host.origin);
        return `${url.pathname}${url.search}`;
      };
      const visit = yield* send({ path: "/", headers: { ...navigation, host: appHost } });
      expect(visit.response.statusCode).toBe(302);
      const approve = yield* send({
        path: redirectPath(visit.response.headers.location),
        headers: { ...navigation, cookie: owner.cookie },
      });
      expect(approve.response.statusCode).toBe(302);
      const signedIn = yield* send({
        path: redirectPath(approve.response.headers.location),
        headers: { ...navigation, host: appHost, cookie: sessionCookies(visit.response.headers) },
      });
      expect(signedIn.response.statusCode).toBe(302);
      const appSession = { host: appHost, cookie: sessionCookies(signedIn.response.headers) };
      const page = yield* send({ path: "/", headers: { ...navigation, ...appSession } });
      expect(page.response.statusCode).toBe(200);
      const context = /<script[^>]*id="executor-context"[^>]*>([^<]+)<\/script>/u.exec(page.text);
      const { version } = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
      )(context?.[1]);

      const subscription = yield* liveStream(
        host.origin,
        {
          path: "/_executor/api/subscribe",
          headers: { ...appSession, origin: `http://${appHost}`, accept: "text/event-stream" },
          body: { version, name: "latest", input: {} },
        },
        (text) => text.includes('"type":"snapshot"'),
      );
      const events = yield* liveStream(
        host.origin,
        {
          path: "/mcp",
          // Streamable HTTP here exposes subscriptions/listen as POST, not GET /mcp.
          headers: {
            authorization: `Bearer ${key.key}`,
            "x-executor-organization": organization.id,
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "subscriptions/listen",
            accept: "application/json, text/event-stream",
          },
          body: {
            jsonrpc: "2.0",
            id: 1,
            method: "subscriptions/listen",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
              notifications: { toolsListChanged: true },
            },
          },
        },
        (text) => text.startsWith(":") || text.includes("data:"),
      );
      expect(events.ended(), "MCP is still streaming").toBe(false);
      expect(subscription.ended(), "the app is still subscribed").toBe(false);

      const signalled = performance.now();
      yield* Effect.sync(() => process.kill(host.pid, "SIGTERM"));
      // Observe the whole stop even if it exceeds the expected shutdown window.
      const exitCode = yield* host.exitCode.pipe(Effect.timeout("25 seconds"));
      const elapsed = performance.now() - signalled;
      yield* driver("both streams ended", () =>
        Promise.all([events.finished, subscription.finished]),
      ).pipe(Effect.timeout("1 second"));
      const log = yield* fs.readFileString(`${host.dataDirectory}/../server.log`);
      yield* Effect.log(
        `SIGTERM to host exit: ${Math.round(elapsed)}ms, exit code ${exitCode}, log at ${host.dataDirectory}/../server.log`,
      );
      // drainGrace in apps/hosted/self-host/native/shutdown.go gives POST streams 10 seconds.
      const drainGraceMs = 10_000;
      expect
        .soft(elapsed, "POST streams get the drain window")
        .toBeGreaterThanOrEqual(drainGraceMs - 1_000);
      expect.soft(elapsed, "SIGTERM to host exit").toBeLessThanOrEqual(drainGraceMs + 5_000);
      expect.soft(exitCode).toBe(0);
      expect.soft(log).not.toMatch(/killed|ReverseProxy read error/u);
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);
