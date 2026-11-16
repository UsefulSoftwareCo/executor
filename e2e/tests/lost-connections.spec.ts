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
 * - A burst of refused or reset new connections, then a stage that answers, plain (the listener is
 *   closed, then opened again) and over TLS (each new connection is reset in its handshake), the
 *   shape of #1089's losses: `main`'s client fails; with the wrapper a GET and a POST are each sent
 *   again on a new connection, 1 and then 2 s later, and answered on the third attempt, each
 *   arriving at the stand-in exactly once. The record counts the repeats and the wait, and the job
 *   summary says a job passed only after them.
 * - A connection that opens, takes the whole request and dies is never sent again, plain or TLS.
 * - The repeats stop at the scenario's bound, when the caller gives up, and for a body that cannot
 *   be sent twice; the failure and the failed scenario's note say for how long the request was
 *   unsent. A failure that is not the connection's (a certificate for another name) is not repeated.
 * - A second copy of the module in one process does not wrap `fetch` again, so no wrapper can read a
 *   written request as never written.
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
  unsentNote,
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
          deadline: () => undefined,
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
  options: {
    readonly body?: unknown;
    readonly main?: boolean;
    /** Send a streamed body, which `fetch` cannot be given twice. */
    readonly stream?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.make(method)(url);
    if (options.body !== undefined)
      request = yield* HttpClientRequest.bodyJson(request, options.body);
    if (options.stream === true)
      request = HttpClientRequest.bodyStream(
        request,
        Stream.make(new TextEncoder().encode("synthetic")),
      );
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
      // A scenario bound half a second away: no repeat can start before it.
      configureLostConnections({
        origins: [origin],
        scenario: () => expect.getState().currentTestName,
        deadline: () => Date.now() + 500,
      });
      const line = failureOf(yield* send("POST", `${origin}/api/onboarding/prepare`, { body: {} }));
      expect(line).toContain("before response (tls)");
      expect(line).toContain("never written to a connection, not sent again: the scenario's bound");
      expect(lostRequestsOf("recorded as a request never written")).toEqual([
        expect.objectContaining({
          method: "POST",
          path: "/api/onboarding/prepare",
          code: "ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE",
          outcome: "lost: never written",
          sent: { written: "nothing", responseStarted: false },
          stopped: "the scenario's bound",
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

/**
 * A stage that refuses or resets every new connection for its first `burstMs`, and then answers,
 * closing each connection after its response. Plain: its listener is closed, so a connect is
 * refused, and opened again on the same port. TLS: each new connection is reset at the client's
 * hello, in the handshake. `take-and-die` instead reads each whole request and then resets.
 */
const burstStage = (
  transport: "plain" | "TLS",
  burstMs: number,
  material?: TlsMaterial,
  mode: "burst" | "take-and-die" = "burst",
) =>
  Effect.acquireRelease(
    Effect.callback<Stage & { readonly close: () => void }>((resume) => {
      const received = new Map<string, number>();
      const arrivals = new Map<string, number>();
      const sockets = new Set<Socket>();
      const until = Date.now() + burstMs;
      let reopen: ReturnType<typeof setTimeout> | undefined;
      const server: Server = createServer((raw) => {
        sockets.add(raw);
        raw.on("close", () => sockets.delete(raw));
        raw.on("error", () => undefined);
        if (transport === "TLS" && Date.now() < until)
          return void raw.once("data", () => raw.resetAndDestroy());
        const socket: Socket =
          transport === "plain" ? raw : new TLSSocket(raw, { isServer: true, ...material });
        socket.on("error", () => undefined);
        let buffered = "";
        socket.on("data", (chunk) => {
          buffered += chunk.toString("latin1");
          const end = buffered.indexOf("\r\n\r\n");
          if (end === -1) return;
          const head = buffered.slice(0, end);
          const length = Number(/content-length:\s*(\d+)/iu.exec(head)?.[1] ?? "0");
          if (buffered.length < end + 4 + length) return;
          const [method, path] = head.split("\r\n")[0]!.split(" ");
          const key = `${method} ${path}`;
          received.set(key, (received.get(key) ?? 0) + 1);
          const id = new RegExp(`^${requestIdHeader}:\\s*(\\S+)`, "imu").exec(head)?.[1] ?? key;
          arrivals.set(id, (arrivals.get(id) ?? 0) + 1);
          if (mode === "take-and-die") return raw.resetAndDestroy();
          socket.end(answer);
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        const origin = `${transport === "plain" ? "http" : "https"}://127.0.0.1:${port}`;
        configureLostConnections({
          origins: [origin],
          scenario: () => expect.getState().currentTestName,
          deadline: () => undefined,
        });
        if (transport === "plain" && mode === "burst") {
          server.close();
          if (Number.isFinite(burstMs))
            reopen = setTimeout(() => server.listen(port, "127.0.0.1"), burstMs);
        }
        resume(
          Effect.succeed({
            origin,
            received,
            arrivals,
            close: () => {
              clearTimeout(reopen);
              for (const socket of sockets) socket.destroy();
              server.close();
            },
          }),
        );
      });
    }),
    ({ close }) => Effect.sync(close),
  );

layer(NodeServices.layer)("Stage requests of which nothing was written", (it) => {
  for (const transport of ["plain", "TLS"] as const) {
    const material = transport === "TLS" ? trustedCertificate : Effect.succeed(undefined);

    it.effect(`${transport}: main's client fails in a burst of refused or reset connections`, () =>
      Effect.gen(function* () {
        const { origin, received } = yield* burstStage(transport, 1_500, yield* material);
        const line = failureOf(
          yield* send("GET", `${origin}/api/organizations/org/resources`, { main: true }),
        );
        expect(line).toContain("before response");
        expect(received.size).toBe(0);
      }),
    );

    for (const method of ["GET", "POST"] as const)
      it.effect(
        `${transport}: a ${method} never written is sent again after 1 and 2 s and answered once`,
        () =>
          Effect.gen(function* () {
            // Refused or reset for 1.5 s: the attempts at 0 and 1 s fail, the one at 3 s is answered.
            const { origin, received, arrivals } = yield* burstStage(
              transport,
              1_500,
              yield* material,
            );
            const path = `/api/organizations/org/${method === "GET" ? "resources" : "apps/app/tools/call"}`;
            const result = yield* send(method, `${origin}${path}`, {
              ...(method === "POST" && { body: { synthetic: true } }),
            });
            expect(result._tag).toBe("Success");
            // Exactly once: one arrival, under the one attempt id that reached the stand-in.
            expect(received.get(`${method} ${path}`)).toBe(1);
            expect([...arrivals.values()]).toEqual([1]);
            const [kept] = lostRequestsOf(expect.getState().currentTestName!);
            expect(kept).toMatchObject({
              method,
              path,
              outcome: "sent again: answered",
              sent: { written: "nothing", responseStarted: false },
            });
            expect(kept!.repeats).toHaveLength(2);
            expect(kept!.elapsedMs).toBeGreaterThanOrEqual(3_000);
            expect(kept!.elapsedMs).toBeLessThan(4_500);
          }),
      );

    it.effect(
      `${transport}: a connection that takes the whole request and dies is not repeated`,
      () =>
        Effect.gen(function* () {
          const { origin, received } = yield* burstStage(
            transport,
            0,
            yield* material,
            "take-and-die",
          );
          const line = failureOf(yield* send("GET", `${origin}/api/organizations/org/resources`));
          expect(line).toMatch(
            /on a new connection \d+ ms old, whole request written, no response/u,
          );
          expect(received.get("GET /api/organizations/org/resources")).toBe(1);
          const [kept] = lostRequestsOf(expect.getState().currentTestName!);
          expect(kept).toMatchObject({ outcome: "lost: new connection" });
          expect(kept!.repeats).toBeUndefined();
        }),
    );
  }

  it.effect("the repeats stop at the scenario's bound, and the failure says how long", () =>
    Effect.gen(function* () {
      const { origin, received } = yield* burstStage("plain", Number.POSITIVE_INFINITY);
      // The bound is 2.5 s away: the repeat after 1 s starts, the one 2 s later would cross it.
      const bound = Date.now() + 2_500;
      configureLostConnections({
        origins: [origin],
        scenario: () => expect.getState().currentTestName,
        deadline: () => bound,
      });
      const line = failureOf(yield* send("POST", `${origin}/api/onboarding/prepare`, { body: {} }));
      expect(Date.now()).toBeLessThan(bound);
      expect(line).toMatch(
        /never written to a connection on any of 2 attempts over 1\.\d s, not sent again: the scenario's bound/u,
      );
      expect(received.size).toBe(0);
      const [kept] = lostRequestsOf(expect.getState().currentTestName!);
      expect(kept).toMatchObject({
        outcome: "lost: never written",
        code: "ECONNREFUSED",
        stopped: "the scenario's bound",
      });
      expect(kept!.repeats).toHaveLength(2);
      expect(unsentNote(expect.getState().currentTestName!)).toMatch(
        /^one stage request was unsent for 1\.\d s: its connect or TLS handshake failed on every attempt/u,
      );
    }),
  );

  it.effect("the repeats stop when the caller gives up, and a stream body is not sent twice", () =>
    Effect.gen(function* () {
      const { origin } = yield* burstStage("plain", Number.POSITIVE_INFINITY);
      // The caller's own bound, a real 1.5 s (the case's clock is a test one), interrupts the request
      // and so aborts the wait before the second repeat.
      const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      const timedOut = yield* http.get(`${origin}/api/organizations/org/resources`).pipe(
        Effect.raceFirst(
          Effect.callback<never, string>((resume) => {
            setTimeout(() => resume(Effect.fail("the caller's bound")), 1_500);
          }),
        ),
        Effect.result,
      );
      expect(timedOut._tag).toBe("Failure");
      // The abort reaches the wait on the next turn of the event loop.
      yield* Effect.callback<void>((resume) => {
        setTimeout(() => resume(Effect.void), 100);
      });
      expect(lostRequestsOf(expect.getState().currentTestName!)[0]).toMatchObject({
        path: "/api/organizations/org/resources",
        outcome: "lost: never written",
        stopped: "the caller gave up",
      });
      const streamed = yield* send("POST", `${origin}/api/organizations/org/apps/app/files`, {
        stream: true,
      });
      expect(failureOf(streamed)).toContain("not sent again: its body cannot be sent twice");
    }),
  );

  it.effect("a certificate that does not verify is not repeated", () =>
    Effect.gen(function* () {
      // The certificate names 127.0.0.1; asked for localhost, the handshake fails verification.
      const { origin, received } = yield* burstStage("TLS", 0, yield* trustedCertificate);
      const named = origin.replace("127.0.0.1", "localhost");
      configureLostConnections({
        origins: [named],
        scenario: () => expect.getState().currentTestName,
        deadline: () => undefined,
      });
      const started = Date.now();
      const line = failureOf(yield* send("GET", `${named}/api/organizations/org/resources`));
      expect(Date.now() - started).toBeLessThan(900);
      expect(line).toContain("not sent again: its failure is not a connection's");
      expect(received.size).toBe(0);
      expect(lostRequestsOf(expect.getState().currentTestName!)[0]).toMatchObject({
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
        outcome: "lost: never written",
        stopped: "its failure is not a connection's",
      });
    }),
  );

  it.effect("a second copy of the module does not wrap fetch again", () =>
    Effect.gen(function* () {
      // A process that loads the module twice, under two module ids, and installs both copies.
      const module = new URL("../support/lost-connections.ts", import.meta.url).href;
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const output = yield* processes.string(
        ChildProcess.make(process.execPath, [
          "--input-type=module",
          "--eval",
          [
            `const first = await import(${JSON.stringify(`${module}?first`)});`,
            `const second = await import(${JSON.stringify(`${module}?second`)});`,
            "first.installLostConnections();",
            "const wrapped = globalThis.fetch;",
            "second.installLostConnections();",
            "console.log(JSON.stringify({ copies: first !== second, wrappedOnce: globalThis.fetch === wrapped }));",
          ].join("\n"),
        ]),
      );
      expect(JSON.parse(output)).toEqual({ copies: true, wrappedOnce: true });
    }),
  );

  it.effect("the job summary counts repeats, and a job that passed only after them says so", () =>
    Effect.gen(function* () {
      const { origin } = yield* burstStage("plain", 1_500);
      expect((yield* send("GET", `${origin}/api/organizations/org/resources`))._tag).toBe(
        "Success",
      );
      const fs = yield* FileSystem.FileSystem;
      const run = yield* fs.makeTempDirectoryScoped();
      yield* saveLostRequests(
        run,
        "scenario-1",
        lostRequestsOf(expect.getState().currentTestName!),
      );
      const records = yield* readLostRequests([run]);
      expect(lostRequestLines(records)).toMatch(
        /^Stage requests lost in transport: 0\.\nStage requests sent again because nothing of them was written to a connection, then answered: 1, after 2 repeats and 3\.\d s of waiting in all\.\n- \d\d:\d\d:\d\d GET \/api\/organizations\/org\/resources \(unwritten; sent again: answered, 3 attempts over 3\.\d s\)$/u,
      );
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const summary = yield* processes.string(
        ChildProcess.make(process.execPath, ["e2e/lost-request-summary.ts", "success", run], {
          env: { GITHUB_STEP_SUMMARY: `${run}/summary.md` },
          extendEnv: true,
        }),
      );
      expect(summary).toMatch(
        /This job passed only after sending 1 stage request again \(2 repeats, 3\.\d s of waiting in all\): nothing of them had been written to a connection\./u,
      );
      expect(summary).toContain("::warning title=Stage requests sent again::");
      expect(summary).not.toContain("title=Lost stage requests::");
    }),
  );
});
