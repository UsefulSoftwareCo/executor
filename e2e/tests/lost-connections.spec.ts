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
  stageRequestLimit,
  stageRequestsOf,
  unsentNote,
} from "../support/lost-connections.ts";
import { CallFailed, readResponse, requestFailureText } from "../support/request-failure.ts";

const unwrapped = globalThis.fetch;
installLostConnections();

type Mode = "reset-on-reuse" | "reset-new" | "partial-then-reset" | "stream";

interface TlsMaterial {
  readonly key: string;
  readonly cert: string;
}

interface Stage {
  readonly origin: string;
  readonly received: Map<string, number>;
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
        const socket: Socket =
          material === undefined ? raw : new TLSSocket(raw, { isServer: true, ...material });
        sockets.add(raw);
        raw.on("error", () => undefined);
        let buffered = "";
        let used = false;
        socket.on("data", (chunk) => {
          buffered += chunk.toString("latin1");
          for (;;) {
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

const send = (
  method: "GET" | "POST",
  url: string,
  options: {
    readonly body?: unknown;
    readonly main?: boolean;
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
        expect(yield* child(true)).toBe(10);
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

layer(NodeServices.layer)("Each scenario's stage requests", (it) => {
  it.effect(
    "records method, short path, status, trace and connection, and never a query, header or cookie",
    () =>
      Effect.gen(function* () {
        const name = expect.getState().currentTestName!;
        const traceId = expect.stringMatching(/^[0-9a-f]{32}$/u);
        const answered = yield* stage("reset-on-reuse");
        const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
        const response = yield* http.execute(
          HttpClientRequest.get(
            `${answered.origin}/api/organizations/0123456789abcdefABCDEF/inventory?token=synthetic-token`,
          ).pipe(
            HttpClientRequest.setHeaders({
              cookie: "session=synthetic-cookie",
              authorization: "Bearer synthetic-bearer",
            }),
          ),
        );
        expect(response.status).toBe(200);
        const reset = yield* stage("reset-new");
        failureOf(yield* send("POST", `${reset.origin}/api/onboarding/prepare`, { body: {} }));
        const { rows, dropped, limit } = stageRequestsOf(name);
        expect({ dropped, limit }).toEqual({ dropped: 0, limit: stageRequestLimit });
        expect(rows).toEqual([
          {
            method: "GET",
            path: "/api/organizations/:id/inventory",
            startedAt: expect.any(String),
            endedAt: expect.any(String),
            durationMs: expect.any(Number),
            status: 200,
            traceId,
            connection: "new",
          },
          {
            method: "POST",
            path: "/api/onboarding/prepare",
            startedAt: expect.any(String),
            endedAt: expect.any(String),
            durationMs: expect.any(Number),
            traceId,
            failure: "ECONNRESET",
            outcome: "lost: new connection",
            connection: "new",
          },
        ]);
        const text = JSON.stringify(rows);
        for (const secret of ["synthetic-token", "synthetic-cookie", "synthetic-bearer", "?"])
          expect(text).not.toContain(secret);
      }),
  );

  it.effect("keeps at most its limit of rows, dropping the oldest and counting them", () =>
    Effect.gen(function* () {
      const name = expect.getState().currentTestName!;
      const { origin } = yield* stage("reset-on-reuse");
      const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      const extra = 3;
      for (let index = 0; index < stageRequestLimit + extra; index++)
        expect((yield* http.get(`${origin}/n${index}`)).status).toBe(200);
      const { rows, dropped } = stageRequestsOf(name);
      expect(rows).toHaveLength(stageRequestLimit);
      expect(dropped).toBe(extra);
      expect(rows[0]!.path).toBe(`/n${extra}`);
      expect(rows.at(-1)!.path).toBe(`/n${stageRequestLimit + extra - 1}`);
    }),
  );
});
