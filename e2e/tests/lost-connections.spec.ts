/**
 * Stage requests on connections of their own (`support/lost-connections.ts`), against a local
 * stand-in stage. The stand-in for 16 November's resets answers the first request on a connection,
 * kept alive, and resets the connection when a second request arrives on it: a request sent down a
 * used connection crosses the close, as #1082's 16 lost requests did (all on reused connections,
 * 12 of them written 1-5 ms after the previous response). Whether a request is lost is decided by
 * that fact, not by a timer.
 *
 * - Under load, GETs and POSTs from eight concurrent callers, over plain connections and over TLS:
 *   `fetch` as it was (`main`'s client, keep-alive) loses requests, POSTs among them; with each
 *   stage request on its own connection none is lost, and the stand-in counts every request
 *   arriving exactly once: nothing is sent twice. Over TLS the reset is the TCP connection's,
 *   under the TLS session, as an edge's would be.
 * - Each entry point installs the wrapper before anything can read `fetch`: a request made through
 *   Effect's client first does not leave the requests after it on a shared connection.
 * - A streamed response still arrives whole.
 * - A stand-in that resets brand-new connections: the request fails, and the failure and the record
 *   say "new connection", a different fault. A reset after a response began says so.
 * - A TLS alert in the handshake (#1088's preparation): its code, `ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE`,
 *   holds a slash. The request is recorded as never written, and its failure says TLS.
 * - The job summary counts each lost request with its time, and an unreadable count is never zero.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createServer, type Server, type Socket } from "node:net";
import { getCACertificates, setDefaultCACertificates, TLSSocket } from "node:tls";
import {
  lostRequestLines,
  lostRequestsUncounted,
  readLostRequests,
  saveLostRequests,
} from "../lost-requests.ts";
import {
  configureLostConnections,
  installLostConnections,
  lostOutcome,
  lostRequestsOf,
  requestIdHeader,
} from "../support/lost-connections.ts";
import { CallFailed, readResponse, requestFailureText } from "../support/request-failure.ts";

// `main`'s client: Node's fetch before the wrapper is installed, keep-alive on.
const unwrapped = globalThis.fetch;
installLostConnections();

/**
 * - `reset-on-reuse`: answer a connection's first request, kept alive; reset it when another
 *   request arrives on it.
 * - `reset-new`: reset every connection at its first request.
 * - `partial-then-reset`: write the first bytes of a status line, then reset.
 * - `stream`: answer with a body in three chunks over 60 ms; reset the connection if it is used again.
 */
type Mode = "reset-on-reuse" | "reset-new" | "partial-then-reset" | "stream";

interface TlsMaterial {
  readonly key: string;
  readonly cert: string;
}

interface Stage {
  readonly origin: string;
  /** Requests the stand-in received, by `METHOD /path`. */
  readonly received: Map<string, number>;
  /** How many times each request id arrived. */
  readonly arrivals: Map<string, number>;
}

const answer =
  "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: keep-alive\r\n\r\n{}";

const stage = (mode: Mode, material?: TlsMaterial) =>
  Effect.acquireRelease(
    Effect.callback<Stage & { readonly close: () => void }>((resume) => {
      const received = new Map<string, number>();
      const arrivals = new Map<string, number>();
      const sockets = new Set<Socket>();
      const server: Server = createServer((raw) => {
        // Over TLS the reset is the TCP connection's, under the TLS session, as an edge's would be.
        const socket: Socket =
          material === undefined ? raw : new TLSSocket(raw, { isServer: true, ...material });
        sockets.add(raw);
        raw.on("error", () => undefined);
        let buffered = "";
        // Set once a request was answered: another request on this connection crosses its close.
        let used = false;
        socket.on("data", (chunk) => {
          buffered += chunk.toString("latin1");
          for (;;) {
            // A request is whole when its headers end and its declared body has arrived.
            const end = buffered.indexOf("\r\n\r\n");
            if (end === -1) return;
            const head = buffered.slice(0, end);
            const length = Number(/content-length:\s*(\d+)/iu.exec(head)?.[1] ?? "0");
            if (buffered.length < end + 4 + length) return;
            buffered = buffered.slice(end + 4 + length);
            const [method, path] = head.split("\r\n")[0]!.split(" ");
            const key = `${method} ${path}`;
            received.set(key, (received.get(key) ?? 0) + 1);
            const id = new RegExp(`^${requestIdHeader}:\\s*(\\S+)`, "imu").exec(head)?.[1] ?? key;
            arrivals.set(id, (arrivals.get(id) ?? 0) + 1);
            if (mode === "reset-new" || used) return raw.resetAndDestroy();
            used = true;
            if (mode === "partial-then-reset")
              return socket.write("HTTP/1.1 2", () => setTimeout(() => raw.resetAndDestroy(), 20));
            if (mode === "stream") {
              socket.write(
                "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\nconnection: keep-alive\r\n\r\n",
              );
              const chunks = ["a", "b", "c"];
              const next = () => {
                const chunk = chunks.shift();
                if (chunk === undefined) return socket.write("0\r\n\r\n");
                socket.write(`1\r\n${chunk}\r\n`, () => setTimeout(next, 20));
              };
              return next();
            }
            socket.write(answer);
          }
        });
        raw.on("close", () => sockets.delete(raw));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        const origin = `${material === undefined ? "http" : "https"}://127.0.0.1:${port}`;
        configureLostConnections({
          origins: [origin],
          scenario: () => expect.getState().currentTestName,
        });
        resume(
          Effect.succeed({
            origin,
            received,
            arrivals,
            close: () => {
              for (const socket of sockets) socket.destroy();
              server.close();
            },
          }),
        );
      });
    }),
    ({ close }) => Effect.sync(close),
  );

/** Send a request through Effect's fetch client and read it; the result, success or failure. */
const send = (
  method: "GET" | "POST",
  url: string,
  options: { readonly body?: unknown; readonly main?: boolean } = {},
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.make(method)(url);
    if (options.body !== undefined)
      request = yield* HttpClientRequest.bodyJson(request, options.body);
    return yield* readResponse(http.execute(request), "10 seconds").pipe(Effect.result);
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    options.main === true
      ? Effect.provideService(FetchHttpClient.Fetch, unwrapped)
      : (self) => self,
  );

/**
 * Eight callers, each sending 25 requests one after another, GETs and POSTs in turn, so a caller's
 * next request follows its previous response at once, as a scenario's do.
 */
const load = (origin: string, main: boolean) =>
  Effect.forEach(
    Array.from({ length: 8 }, (_, caller) => caller),
    (caller) =>
      Effect.forEach(
        Array.from({ length: 25 }, (_, index) => index),
        (index) =>
          (index % 2 === 0
            ? send("GET", `${origin}/api/organizations/org/resources`, { main })
            : send("POST", `${origin}/api/organizations/org/apps/app/tools/call`, {
                body: { caller, index },
                main,
              })
          ).pipe(Effect.map((result) => ({ method: index % 2 === 0 ? "GET" : "POST", result }))),
      ),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((results) => results.flat()));

const failureOf = (result: Effect.Success<ReturnType<typeof send>>) => {
  expect(result._tag).toBe("Failure");
  const failure = result._tag === "Failure" ? result.failure : undefined;
  expect(failure).toBeInstanceOf(CallFailed);
  return requestFailureText((failure as CallFailed).failure);
};

/** A certificate for 127.0.0.1, trusted for the case only, the new connections included. */
const trustedCertificate = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "lost-connections-tls-" });
  yield* processes.string(
    ChildProcess.make(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        `${directory}/key.pem`,
        "-out",
        `${directory}/cert.pem`,
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stderr: "pipe" },
    ),
  );
  const material = {
    key: yield* fs.readFileString(`${directory}/key.pem`),
    cert: yield* fs.readFileString(`${directory}/cert.pem`),
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const trusted = getCACertificates("default");
      setDefaultCACertificates([...trusted, material.cert]);
      return trusted;
    }),
    (trusted) => Effect.sync(() => setDefaultCACertificates(trusted)),
  );
  return material;
});

layer(NodeServices.layer)("Stage requests on connections of their own", (it) => {
  for (const transport of ["plain", "TLS"] as const) {
    const material = transport === "TLS" ? trustedCertificate : Effect.succeed(undefined);

    it.effect(
      `main's client loses requests, POSTs among them, sent down a used connection (${transport})`,
      () =>
        Effect.gen(function* () {
          const { origin } = yield* stage("reset-on-reuse", yield* material);
          const results = yield* load(origin, true);
          const lost = results.filter(({ result }) => result._tag === "Failure");
          expect(lost.length).toBeGreaterThan(0);
          expect(lost.some(({ method }) => method === "POST")).toBe(true);
        }),
    );

    it.effect(
      `loses none and sends none twice with each stage request on its own connection (${transport})`,
      () =>
        Effect.gen(function* () {
          const { origin, arrivals } = yield* stage("reset-on-reuse", yield* material);
          const results = yield* load(origin, false);
          expect(results.filter(({ result }) => result._tag === "Failure")).toHaveLength(0);
          expect(arrivals.size).toBe(200);
          expect([...arrivals.values()].every((count) => count === 1)).toBe(true);
          expect(
            lostRequestsOf(`each stage request on its own connection (${transport})`),
          ).toHaveLength(0);
        }),
    );
  }

  it.effect("every entry point installs the wrapper before anything can read fetch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // The first two imports of each entry point that makes outbound calls, and of every setup
      // file of the Vitest config the targets run under, are the connect time-out, then this.
      const firstTwo = (text: string) =>
        [...text.matchAll(/^import (?:[^;]*? from )?"([^"]+)";/gm)]
          .slice(0, 2)
          .map((match) => match[1]);
      const order = ["./support/connect-timeout.ts", "./support/stage-connections.ts"];
      const callers: Array<string> = [];
      for (const name of (yield* fs.readDirectory("e2e")).toSorted()) {
        if (!name.endsWith(".ts")) continue;
        const text = yield* fs.readFileString(`e2e/${name}`);
        if (
          /NodeRuntime\.runMain/.test(text) &&
          /FetchHttpClient|runSuite\(|runDeployedSuite|startDeployment/.test(text)
        ) {
          callers.push(`e2e/${name}`);
          expect(firstTwo(text), name).toEqual(order);
        }
      }
      expect(callers).toEqual([
        "e2e/cleanup-deployed.ts",
        "e2e/cli.ts",
        "e2e/create-emulators.ts",
        "e2e/deployed.ts",
        "e2e/run.ts",
      ]);
      const config = yield* fs.readFileString("e2e/vitest.config.ts");
      const setupFiles = [...config.matchAll(/setupFiles: \[([^\]]*)\]/g)].flatMap((match) =>
        [...match[1]!.matchAll(/"([^"]+)"/g)].map((file) => file[1]!),
      );
      expect(setupFiles.length).toBeGreaterThan(0);
      for (const file of setupFiles)
        expect(firstTwo(yield* fs.readFileString(file)), file).toEqual(order);
    }),
  );

  it.effect(
    "a request through Effect's client before the stage is known leaves later stage requests each on its own connection",
    () =>
      Effect.gen(function* () {
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        // A plain keep-alive server that counts the connections stage requests arrive on.
        const counted = yield* Effect.acquireRelease(
          Effect.callback<{
            readonly origin: string;
            readonly connections: Set<Socket>;
            readonly close: () => void;
          }>((resume) => {
            const connections = new Set<Socket>();
            const sockets = new Set<Socket>();
            const server = createServer((socket) => {
              sockets.add(socket);
              socket.on("data", (chunk) => {
                const text = chunk.toString("latin1");
                if (!text.includes("\r\n\r\n")) return;
                if (text.startsWith("GET /api/")) connections.add(socket);
                socket.write(answer);
              });
              socket.on("error", () => undefined);
              socket.on("close", () => sockets.delete(socket));
            });
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              const port = typeof address === "object" && address !== null ? address.port : 0;
              resume(
                Effect.succeed({
                  origin: `http://127.0.0.1:${port}`,
                  connections,
                  close: () => {
                    for (const socket of sockets) socket.destroy();
                    server.close();
                  },
                }),
              );
            });
          }),
          ({ close }) => Effect.sync(close),
        );
        /**
         * A process that, like the deployed suite, makes a request through Effect's client before
         * the stage is named (its `/health` check), then names the stage and sends ten requests.
         * `early` imports the wrappers as the entry points do; otherwise it installs the wrapper
         * after the first request, as the preparation used to.
         */
        const child = (early: boolean) =>
          Effect.gen(function* () {
            const code = [
              'import "./e2e/support/connect-timeout.ts";',
              early ? 'import "./e2e/support/stage-connections.ts";' : "",
              'import { Effect } from "effect";',
              'import { FetchHttpClient, HttpClient } from "effect/http";',
              'import { addStageOrigins, installLostConnections } from "./e2e/support/lost-connections.ts";',
              "const origin = process.env.STAGE;",
              "await Effect.runPromise(Effect.gen(function* () {",
              "  const http = yield* HttpClient.HttpClient;",
              "  yield* http.get(`${origin}/health`).pipe(Effect.flatMap((r) => r.text));",
              early ? "" : "  installLostConnections();",
              "  addStageOrigins([origin]);",
              "  for (let i = 0; i < 10; i++) yield* http.get(`${origin}/api/${i}`).pipe(Effect.flatMap((r) => r.text));",
              "}).pipe(Effect.provide(FetchHttpClient.layer)));",
            ].join("\n");
            counted.connections.clear();
            const spawned = yield* processes.spawn(
              ChildProcess.make(process.execPath, ["--input-type=module", "-e", code], {
                env: { STAGE: counted.origin },
                extendEnv: true,
              }),
            );
            const [, , exit] = yield* Effect.all(
              [
                spawned.stdout.pipe(Stream.decodeText(), Stream.mkString),
                spawned.stderr.pipe(Stream.decodeText(), Stream.mkString),
                spawned.exitCode,
              ],
              { concurrency: "unbounded" },
            );
            expect(Number(exit)).toBe(0);
            return counted.connections.size;
          }).pipe(Effect.scoped);
        // Installed first: ten stage requests, ten connections.
        expect(yield* child(true)).toBe(10);
        // Installed after the first request, as the deployed suite's preparation did: the ten
        // share Node's keep-alive pool. This is the gap the entry points' import closes.
        expect(yield* child(false)).toBeLessThan(10);
      }),
  );

  it.effect("a streamed response arrives whole", () =>
    Effect.gen(function* () {
      const { origin } = yield* stage("stream");
      const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      const text = yield* http
        .get(`${origin}/api/organizations/org/events`)
        .pipe(Effect.flatMap((response) => response.text));
      expect(text).toBe("abc");
    }),
  );

  it.effect("a reset on a brand-new connection fails and is recorded as a new connection", () =>
    Effect.gen(function* () {
      const { origin, received } = yield* stage("reset-new");
      const line = failureOf(yield* send("POST", `${origin}/api/onboarding/prepare`, { body: {} }));
      expect(line).toMatch(
        /before response \(reset\).*on a new connection \d+ ms old, whole request written, no response/u,
      );
      expect(received.get("POST /api/onboarding/prepare")).toBe(1);
      expect(lostRequestsOf("is recorded as a new connection")[0]).toMatchObject({
        method: "POST",
        path: "/api/onboarding/prepare",
        outcome: "lost: new connection",
        sent: {
          connection: "new",
          earlierRequests: 0,
          written: "whole request",
          responseStarted: false,
        },
      });
    }),
  );

  it.effect("a TLS alert in the handshake is recorded as a request never written", () =>
    Effect.gen(function* () {
      // Answers the client's hello with a fatal handshake_failure alert, as an edge without a
      // certificate for the name does: record type 21, TLS 1.2, length 2, fatal (2), alert 40.
      const { origin } = yield* Effect.acquireRelease(
        Effect.callback<{ readonly origin: string; readonly server: Server }>((resume) => {
          const server = createServer((socket) => {
            socket.on("error", () => undefined);
            socket.once("data", () => socket.end(Buffer.from([21, 3, 3, 0, 2, 2, 40])));
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            resume(Effect.succeed({ origin: `https://127.0.0.1:${port}`, server }));
          });
        }),
        ({ server }) => Effect.sync(() => server.close()),
      );
      configureLostConnections({
        origins: [origin],
        scenario: () => expect.getState().currentTestName,
      });
      const line = failureOf(yield* send("POST", `${origin}/api/onboarding/prepare`, { body: {} }));
      expect(line).toContain("before response (tls)");
      expect(lostRequestsOf("recorded as a request never written")).toEqual([
        expect.objectContaining({
          method: "POST",
          path: "/api/onboarding/prepare",
          code: "ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE",
          outcome: "lost: never written",
          sent: { written: "nothing", responseStarted: false },
        }),
      ]);
    }),
  );

  it.effect("a reset after a response began is recorded as such", () =>
    Effect.gen(function* () {
      const { origin } = yield* stage("partial-then-reset");
      const line = failureOf(yield* send("GET", `${origin}/api/organizations/org/resources`));
      expect(line).toContain("a response had begun");
      expect(lostRequestsOf("recorded as such")[0]?.outcome).toBe("lost: response had begun");
    }),
  );

  it.effect(
    "the job summary counts lost requests with their times, and never shows an unread count as zero",
    () =>
      Effect.gen(function* () {
        const { origin } = yield* stage("reset-new");
        yield* send("GET", `${origin}/api/organizations/org/resources`);
        const fs = yield* FileSystem.FileSystem;
        const run = yield* fs.makeTempDirectoryScoped();
        yield* saveLostRequests(
          run,
          "scenario-1",
          lostRequestsOf("never shows an unread count as zero"),
        );
        const records = yield* readLostRequests([run]);
        expect(lostRequestLines(records)).toMatch(
          /^Stage requests lost in transport: 1 \(1 lost: new connection\)\.\n- \d\d:\d\d:\d\d GET \/api\/organizations\/org\/resources \(new; lost: new connection\)$/u,
        );
        expect(lostRequestLines([])).toBe("Stage requests lost in transport: 0.");
        expect(lostRequestsUncounted).toContain("NOT COUNTED");
        expect(lostRequestsUncounted).toContain("not zero");
        expect(
          lostOutcome({ connection: "reused", written: "whole request", responseStarted: false }),
        ).toBe("lost: reused connection");
      }),
  );
});
