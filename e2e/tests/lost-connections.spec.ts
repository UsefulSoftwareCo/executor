/**
 * A stage request lost on a connection the far end had dropped (`support/lost-connections.ts`).
 * A local server stands in for the stage: it answers a request on a kept-alive connection and
 * then, on the next request down that connection, resets it, the shape of the deployed-suite
 * resets of 16 November (`GET …/resources` reset after 68 ms, `DELETE …/apps/:id` after 39 and
 * 54 ms, `POST /api/onboarding/prepare` after 44 ms, none of which reached a Worker).
 *
 * - `fetch` as it is (`main`'s client) fails the second GET; with the wrapper it is sent again
 *   once on a new connection, answered, and kept as one resend.
 * - A POST or DELETE whose request was written is not sent again: the server sees it once and the
 *   failure says why.
 * - A reset on a new connection, and a reset after a response's first bytes, are not sent again.
 * - The records round-trip through the run's `report/lost-requests/`, and the job summary counts
 *   the resend with its time; a summary that drops the count fails here.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { createServer, type Server, type Socket } from "node:net";
import { getCACertificates, setDefaultCACertificates, TLSSocket } from "node:tls";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { lostRequestLines, readLostRequests, saveLostRequests } from "../lost-requests.ts";
import {
  changesState,
  configureLostConnections,
  installLostConnections,
  lostRequestsOf,
  resendable,
} from "../support/lost-connections.ts";
import { resendNote } from "../support/lifecycle.ts";
import { CallFailed, readResponse, requestFailureText } from "../support/request-failure.ts";

// `main`'s client: Node's fetch before the wrapper is installed.
const unwrapped = globalThis.fetch;
installLostConnections();

/**
 * How the stand-in stage treats the second request on one connection, or the first request on
 * any connection (`reset-new`). Requests it answers get `200 {}` on a kept-alive connection.
 */
type Mode = "reset-reused" | "reset-new" | "partial-then-reset";

interface Stage {
  readonly origin: string;
  /** Requests the server received, by `METHOD /path`, including those it then reset. */
  readonly received: Map<string, number>;
}

/** A certificate for 127.0.0.1, trusted for the case's requests only, for a stand-in over TLS. */
interface TlsMaterial {
  readonly key: string;
  readonly cert: string;
}

const stage = (mode: Mode, material?: TlsMaterial) =>
  Effect.acquireRelease(
    Effect.callback<Stage & { readonly close: () => void }>((resume) => {
      const received = new Map<string, number>();
      const sockets = new Set<Socket>();
      const server: Server = createServer((raw) => {
        // Over TLS the reset is the TCP connection's, under the TLS session, as an edge's would be.
        const socket: Socket =
          material === undefined ? raw : new TLSSocket(raw, { isServer: true, ...material });
        sockets.add(raw);
        let served = 0;
        let buffered = "";
        socket.on("data", (chunk) => {
          buffered += chunk.toString("latin1");
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
          served += 1;
          const reset = mode === "reset-new" ? served === 1 : served === 2;
          if (reset && mode === "partial-then-reset")
            socket.write("HTTP/1.1 2", () => setTimeout(() => raw.resetAndDestroy(), 20));
          else if (reset) raw.resetAndDestroy();
          else
            socket.write(
              "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: keep-alive\r\n\r\n{}",
            );
        });
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => undefined);
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

/** Send a request through Effect's fetch client and read it, returning the failure if it fails. */
const send = (
  method: "GET" | "POST" | "DELETE",
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

/** One answered request opens the connection the next request reuses. */
const warm = (origin: string) =>
  send("GET", `${origin}/warm`).pipe(
    Effect.tap((result) => Effect.sync(() => expect(result._tag).toBe("Success"))),
    // Let the answered connection go back to the pool. A real timer: the case's clock is a test one.
    Effect.andThen(
      Effect.callback<void>((resume) => {
        setTimeout(() => resume(Effect.void), 50);
      }),
    ),
  );

const failureOf = (result: Effect.Success<ReturnType<typeof send>>) => {
  expect(result._tag).toBe("Failure");
  const failure = result._tag === "Failure" ? result.failure : undefined;
  expect(failure).toBeInstanceOf(CallFailed);
  return requestFailureText((failure as CallFailed).failure);
};

layer(NodeServices.layer)("A stage request lost on a dropped connection", (it) => {
  it.effect("main's client fails a GET sent down a connection the far end reset", () =>
    Effect.gen(function* () {
      const { origin } = yield* stage("reset-reused");
      yield* warm(origin);
      const line = failureOf(
        yield* send("GET", `${origin}/api/organizations/org/resources`, { main: true }),
      );
      expect(line).toContain("before response (reset)");
      // Without the wrapper nothing says how the connection was used.
      expect(line).not.toContain("connection");
    }),
  );

  it.effect("sends the GET again once on a new connection, answered, and keeps it", () =>
    Effect.gen(function* () {
      const { origin, received } = yield* stage("reset-reused");
      yield* warm(origin);
      const result = yield* send("GET", `${origin}/api/organizations/org/resources`);
      expect(result._tag).toBe("Success");
      // The first copy reached the server and was reset; the second, on a new connection, answered.
      expect(received.get("GET /api/organizations/org/resources")).toBe(2);
      const kept = lostRequestsOf("answered, and keeps it");
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({
        method: "GET",
        path: "/api/organizations/org/resources",
        code: "ECONNRESET",
        outcome: "sent again: answered",
        sent: { connection: "reused", written: "whole request", responseStarted: false },
      });
      expect(kept[0]!.sent.idleMs).toBeGreaterThanOrEqual(0);
    }),
  );

  it.effect("does not send a written POST again, and the failure says why", () =>
    Effect.gen(function* () {
      const { origin, received } = yield* stage("reset-reused");
      yield* warm(origin);
      const line = failureOf(
        yield* send("POST", `${origin}/api/onboarding/prepare`, { body: { name: "synthetic" } }),
      );
      expect(received.get("POST /api/onboarding/prepare")).toBe(1);
      expect(line).toContain("before response (reset)");
      expect(line).toMatch(
        /on a reused connection idle \d+\.\d s, whole request written, no response, not sent again: may have been processed/u,
      );
    }),
  );

  it.effect("does not send a written DELETE again", () =>
    Effect.gen(function* () {
      const { origin, received } = yield* stage("reset-reused");
      yield* warm(origin);
      const line = failureOf(yield* send("DELETE", `${origin}/api/organizations/org/apps/app`));
      expect(line).toContain("not sent again: may have been processed");
      expect(received.get("DELETE /api/organizations/org/apps/app")).toBe(1);
    }),
  );

  it.effect("does not send a GET that changes state again", () =>
    Effect.gen(function* () {
      const { origin, received } = yield* stage("reset-reused");
      yield* warm(origin);
      const line = failureOf(
        yield* send("GET", `${origin}/api/auth/callback/google?code=c&state=s`),
      );
      expect(line).toContain("not sent again: GET may change state");
      expect(received.get("GET /api/auth/callback/google?code=c&state=s")).toBe(1);
    }),
  );

  it.effect("does not send a GET again when the reset came on a new connection", () =>
    Effect.gen(function* () {
      const { origin, received } = yield* stage("reset-new");
      const line = failureOf(yield* send("GET", `${origin}/api/organizations/org/resources`));
      expect(line).toMatch(
        /on a new connection, whole request written, no response, not sent again: new connection/u,
      );
      expect(received.get("GET /api/organizations/org/resources")).toBe(1);
    }),
  );

  it.effect("does not send a GET again when a response's first bytes had arrived", () =>
    Effect.gen(function* () {
      const { origin, received } = yield* stage("partial-then-reset");
      yield* warm(origin);
      const line = failureOf(yield* send("GET", `${origin}/api/organizations/org/resources`));
      expect(line).toContain("a response had begun, not sent again: response had begun");
      expect(received.get("GET /api/organizations/org/resources")).toBe(1);
    }),
  );

  it.effect("saves the resend for the run and counts it in the job summary with its time", () =>
    Effect.gen(function* () {
      const { origin } = yield* stage("reset-reused");
      yield* warm(origin);
      expect((yield* send("GET", `${origin}/api/organizations/org/resources`))._tag).toBe(
        "Success",
      );
      const fs = yield* FileSystem.FileSystem;
      const run = yield* fs.makeTempDirectoryScoped();
      yield* saveLostRequests(run, "scenario-1", lostRequestsOf("with its time"));
      const records = yield* readLostRequests([run]);
      expect(records).toHaveLength(1);
      expect(lostRequestLines(records)).toMatch(
        /^Stage requests lost before any response: 1 \(1 sent again: answered\)\.\n- \d\d:\d\d:\d\d GET \/api\/organizations\/org\/resources \(reused, idle \d+\.\d s; sent again: answered with HTTP 200\)$/u,
      );
      expect(lostRequestLines([])).toBe("Stage requests lost before any response: 0.");
    }),
  );

  it.effect("sends a GET again over TLS too, and leaves a written POST over TLS alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "lost-connections-tls-" });
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
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
      // Trust this certificate for the case, the resend's new connections included, then restore.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const trusted = getCACertificates("default");
          setDefaultCACertificates([...trusted, material.cert]);
          return trusted;
        }),
        (trusted) => Effect.sync(() => setDefaultCACertificates(trusted)),
      );
      const reads = yield* stage("reset-reused", material);
      yield* warm(reads.origin);
      expect((yield* send("GET", `${reads.origin}/api/organizations/org/resources`))._tag).toBe(
        "Success",
      );
      expect(reads.received.get("GET /api/organizations/org/resources")).toBe(2);
      expect(lostRequestsOf("leaves a written POST over TLS alone")[0]).toMatchObject({
        outcome: "sent again: answered",
        sent: { connection: "reused", written: "whole request", responseStarted: false },
      });
      const writes = yield* stage("reset-reused", material);
      yield* warm(writes.origin);
      const line = failureOf(
        yield* send("POST", `${writes.origin}/api/onboarding/prepare`, { body: { name: "s" } }),
      );
      expect(line).toContain("not sent again: may have been processed");
      expect(writes.received.get("POST /api/onboarding/prepare")).toBe(1);
    }),
  );

  it.effect(
    "sends again only a GET or HEAD that changes nothing, lost on a reused connection before any response",
    () =>
      Effect.sync(() => {
        const reused = {
          connection: "reused",
          written: "whole request",
          responseStarted: false,
        } as const;
        const read = new URL("http://127.0.0.1/api/organizations/org/resources");
        expect(resendable("GET", read, reused)).toBe(true);
        expect(resendable("HEAD", read, reused)).toBe(true);
        for (const method of ["POST", "PUT", "PATCH", "DELETE"])
          expect(resendable(method, read, reused)).toBe("not sent again: may have been processed");
        expect(resendable("GET", read, { ...reused, connection: "new" })).toBe(
          "not sent again: new connection",
        );
        expect(resendable("GET", read, { written: "nothing", responseStarted: false })).toBe(
          "not sent again: new connection",
        );
        expect(resendable("GET", read, { ...reused, responseStarted: true })).toBe(
          "not sent again: response had begun",
        );
        // The stage GETs the harness sends that change state: a callback consumes its code, an
        // authorization issues one, an unsubscribe link unsubscribes.
        for (const url of [
          "http://127.0.0.1/api/auth/callback/google?code=c&state=s",
          "http://127.0.0.1/api/oauth/callback?state=s",
          "http://127.0.0.1/api/auth/oauth2/authorize?client_id=c",
          "http://127.0.0.1/api/email/unsubscribe?token=t",
          "http://127.0.0.1/api/email/unsubscribe",
          "http://127.0.0.1/api/anything?token=t",
        ])
          expect(resendable("GET", new URL(url), reused)).toBe(
            "not sent again: GET may change state",
          );
        expect(changesState(read)).toBe(false);
      }),
  );

  it.effect("a failed scenario names the request that was sent again and its answer", () =>
    Effect.sync(() => {
      expect(
        resendNote([
          {
            at: "2026-11-16T17:56:09.000Z",
            method: "GET",
            path: "/api/auth/oauth2/get-consents",
            elapsedMs: 41,
            sent: {
              connection: "reused",
              idleMs: 4100,
              written: "whole request",
              responseStarted: false,
            },
            outcome: "sent again: answered",
            againStatus: 409,
          },
        ]),
      ).toBe(
        "A request of this scenario was sent again after its reused connection was lost before any response (e2e/support/lost-connections.ts): GET /api/auth/oauth2/get-consents at 17:56:09, sent again: answered with HTTP 409. The failure above may come from the second attempt's answer.",
      );
    }),
  );
});
