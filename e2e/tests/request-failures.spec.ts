/**
 * A call that gets no usable response says how far it got: whether a response began, with which
 * status, whether it failed in transport or while decoding the body, the error tags and low-level
 * code, and how long it ran. Calls to emulators.dev (`emulatorRequest`) and to the product or a
 * stage (`SessionClients`) each report it. A local server stands in for both and fails one way per
 * path: it resets the connection, stalls, closes mid-body, or answers HTML. Nothing it was sent or
 * answered, a query, a header value or a body, appears in any rendering of the failure, nor does a
 * JSON parser's message, which quotes the start of the body.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { preparationFailure } from "../sdk/prepare-scenarios.ts";
import { RequestFailed, SessionClients } from "../support/api.ts";
import { EmulatorDeadline, emulatorRequest } from "../support/emulators.ts";
import { failureText, stepFailureText } from "../support/failure-text.ts";
import { Target, withCause } from "../support/platform.ts";
import { CallFailed, parseJson, readResponse } from "../support/request-failure.ts";

const suffix = "0123456789abcdef01234567";
const token = "emu_resend_SYNTHETICtoken0001";
const queryValue = "SYNTH-QUERY-482913";
const bodyValue = "SYNTH-BODY-771204";
// A JSON parser's message quotes only the first characters of the body, so the HTML answer starts
// with this marker: a printed parser message would show it.
const bodyStart = "SYNTHMK7Q2";
const secrets = [suffix, token, queryValue, bodyValue, bodyStart];
// Wording from Node's and Schema's JSON parse errors, which quote the body they refused.
const parserWords = ["not valid JSON", "Unexpected token", "Unexpected end"];
const leaked = (text: string) =>
  [...secrets, ...parserWords].filter((secret) => text.includes(secret));

/** Fails each request the way its last path segment names. */
const failing = (request: IncomingMessage, response: ServerResponse): void => {
  const kind = (request.url ?? "").split("?")[0]?.split("/").at(-1) ?? "";
  const socket = response.socket;
  switch (kind) {
    case "reset":
      // A TCP reset before any response byte.
      socket?.resetAndDestroy();
      return;
    case "closed":
      // The server closes the connection without answering.
      socket?.destroy();
      return;
    case "mid-body":
    case "mid-body-404": {
      // Headers first; once they have gone, part of the promised body, then the connection closes.
      response.writeHead(kind === "mid-body" ? 200 : 404, {
        "content-type": "application/json",
        "content-length": "4096",
      });
      response.flushHeaders();
      setTimeout(() => {
        response.write('{"partial":');
        setTimeout(() => socket?.destroy(), 50);
      }, 100);
      return;
    }
    case "html":
      // A whole answer that is not JSON, as an edge error page is.
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(`${bodyStart}<html>not json ${bodyValue}</html>`);
      return;
    case "empty":
      // A 2xx with no body is no value, not a decode failure.
      response.writeHead(200, { "content-type": "application/json" }).end();
      return;
    case "headers-then-stall":
      // Headers arrive; the body never does.
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      return;
    case "stall":
      // Nothing is ever sent.
      return;
    default:
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
  }
};

const stub = Effect.acquireRelease(
  Effect.callback<{ readonly origin: string; readonly server: Server }>((resume) => {
    const server = createServer(failing);
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resume(Effect.succeed({ origin: `http://localhost:${port}`, server }));
    });
  }),
  ({ server }) =>
    Effect.sync(() => {
      server.closeAllConnections();
      server.close();
    }),
);

/**
 * Port 3 on loopback: a privileged port, so only root may bind it and no process of the job can
 * take it between calls, and not on fetch's list of blocked ports. Nothing listens there on a
 * runner, so connecting is refused.
 */
const refusedOrigin = "http://localhost:3";

const emulatorCall = (origin: string, path: string) =>
  emulatorRequest(
    `${origin}/resend/kind-${suffix}`,
    `${path}?code=${queryValue}`,
    { value: bodyValue },
    token,
  ).pipe(Effect.flip, Effect.provide(FetchHttpClient.layer));

/** A self-host target at `origin`, as the runner describes one. */
const targetAt = (origin: string) =>
  Layer.succeed(
    Target,
    Target.of({
      metadata: {
        target: "self-host",
        origin,
        mode: "attached",
        runtime: "node",
        commit: "0000000",
        dirty: false,
        startedAt: "2026-01-01T00:00:00.000Z",
        interactive: false,
        diagnostics: "",
      },
      directory: "",
      apiKey: Redacted.make(token),
      rows: 1,
      observeUI: false,
      recordingPaceMs: 0,
    }),
  );

const productCall = (origin: string, path: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionClients;
    const session = yield* sessions.session();
    return yield* sessions
      .request(
        session,
        "POST",
        `${path}?code=${queryValue}`,
        { value: bodyValue },
        {
          authorization: `Bearer ${token}`,
        },
      )
      .pipe(Effect.flip);
  }).pipe(
    Effect.provide(
      SessionClients.layer.pipe(Layer.provide([targetAt(origin), FetchHttpClient.layer])),
    ),
  );

// The cases run on the real clock (no TestClock): the deadline and elapsed time are what they check.

/**
 * Every rendering of a failure a job log, result.json, preparation.json or a span could carry:
 * the message, the string and JSON forms, Effect's pretty cause, the harness's failure text (what
 * the runner records for a failed step) and preparation's record.
 */
const renderings = (error: object & { message: string }) => [
  error.message,
  String(error),
  JSON.stringify(error),
  Cause.pretty(Cause.fail(error)),
  failureText(error),
  stepFailureText(Cause.fail(error)),
  JSON.stringify(preparationFailure(error) ?? null),
];

layer(NodeServices.layer, { excludeTestServices: true })("Request failures", (it) => {
  it.effect("an emulator call says how far it got before it failed", () =>
    Effect.gen(function* () {
      const { origin } = yield* stub;
      const refused = yield* emulatorCall(refusedOrigin, "/x");
      const reset = yield* emulatorCall(origin, "/reset");
      const closed = yield* emulatorCall(origin, "/closed");
      const midBody = yield* emulatorCall(origin, "/mid-body");
      const html = yield* emulatorCall(origin, "/html");
      const refusedBody = yield* emulatorCall(origin, "/mid-body-404");
      const empty = yield* emulatorRequest(`${origin}/resend/kind-${suffix}`, "/empty").pipe(
        Effect.provide(FetchHttpClient.layer),
      );

      expect(empty).toBeNull();
      // A refusal whose body could not be read keeps its status for callers that match on it.
      expect(refusedBody.status).toBe(404);
      expect(refusedBody.failure).toMatchObject({ stage: "reading body", status: 404 });
      for (const text of renderings(refusedBody)) expect(leaked(text)).toEqual([]);
      expect(refused.failure).toMatchObject({ stage: "before response", code: "ECONNREFUSED" });
      expect(refused.failure?.status).toBeUndefined();
      expect(reset.failure).toMatchObject({ stage: "before response", code: "ECONNRESET" });
      expect(closed.failure).toMatchObject({ stage: "before response", code: "UND_ERR_SOCKET" });
      expect(midBody.failure).toMatchObject({ stage: "reading body", status: 200 });
      expect(midBody.failure?.code).toMatch(/^(?:UND_ERR_SOCKET|ECONNRESET|ABORT_ERR)$/u);
      expect(html.failure).toMatchObject({ stage: "decoding body", status: 200 });
      expect(html.failure?.errors).toContain("SyntaxError");
      for (const error of [refused, reset, closed, midBody, html]) {
        expect(error.reason).toBe("request");
        expect(error.failure?.errors).toMatch(/^[A-Za-z]+(?: > [A-Za-z]+)*$/u);
        expect(error.failure?.elapsedMs).toBeGreaterThanOrEqual(0);
        for (const text of renderings(error)) expect(leaked(text)).toEqual([]);
      }
      // Five failures, five different answers to "what happened".
      const kinds = [refused, reset, closed, midBody, html].map((error) =>
        JSON.stringify([error.failure?.stage, error.failure?.status, error.failure?.code]),
      );
      expect(new Set(kinds).size).toBe(5);
      expect(reset.message).toMatch(
        /^External emulator failed: POST \/reset on resend\/kind-… #[0-9a-f]{12} \(request: before response, [A-Za-z >]+ ECONNRESET, after \d+ ms\)$/u,
      );
      expect(midBody.message).toContain("(request: reading body of HTTP 200, ");
      expect(html.message).toContain("(request: decoding body of HTTP 200, SyntaxError, after ");
    }),
  );

  it.effect(
    "an emulator call that stalls says whether its response had begun",
    () =>
      Effect.gen(function* () {
        const { origin } = yield* stub;
        // The same deadline logic as the harness's 30 s, shortened for this spec only.
        const [stalled, headersOnly] = yield* Effect.all(
          [emulatorCall(origin, "/stall"), emulatorCall(origin, "/headers-then-stall")],
          { concurrency: 2 },
        ).pipe(Effect.provideService(EmulatorDeadline, "1 second"));
        expect(stalled.reason).toBe("timeout");
        expect(stalled.failure).toMatchObject({ stage: "timeout" });
        expect(stalled.failure?.status).toBeUndefined();
        expect(headersOnly.reason).toBe("timeout");
        expect(headersOnly.failure).toMatchObject({ stage: "timeout", status: 200 });
        expect(stalled.failure?.elapsedMs).toBeGreaterThanOrEqual(950);
        expect(stalled.message).toMatch(/\(timeout, after \d+ ms\)$/u);
        expect(headersOnly.message).toContain("(timeout after the headers of HTTP 200, after ");
        for (const error of [stalled, headersOnly])
          for (const text of renderings(error)) expect(leaked(text)).toEqual([]);
      }),
    { timeout: 10_000 },
  );

  it.effect(
    "a body that is not JSON passes on no parser text, however its failure is wrapped",
    () =>
      Effect.gen(function* () {
        const { origin } = yield* stub;
        // As the events helper wraps its `POST /mcp`: the failure's cause becomes the kept cause.
        const error = yield* Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient;
          const { response, text, started } = yield* readResponse(
            http.execute(HttpClientRequest.get(`${origin}/html`)),
          );
          return yield* parseJson(text, response.status, started);
        }).pipe(
          Effect.scoped,
          Effect.mapError((cause) =>
            cause instanceof CallFailed
              ? withCause(
                  new RequestFailed({
                    method: "POST",
                    path: "/mcp",
                    reason: "request",
                    failure: cause.failure,
                    cause: cause.cause,
                  }),
                )
              : cause,
          ),
          Effect.flip,
          Effect.provide(FetchHttpClient.layer),
        );
        expect(error).toBeInstanceOf(RequestFailed);
        if (!(error instanceof RequestFailed)) return;
        expect(error.failure).toMatchObject({ stage: "decoding body", status: 200 });
        expect(error.failure?.errors).toBe("SyntaxError");
        for (const text of renderings(error)) expect(leaked(text)).toEqual([]);
      }),
  );

  it.effect("a product call says how far it got before it failed", () =>
    Effect.gen(function* () {
      const { origin } = yield* stub;
      const refused = yield* productCall(refusedOrigin, "/api/x");
      const reset = yield* productCall(origin, "/api/reset");
      const midBody = yield* productCall(origin, "/api/mid-body");
      const html = yield* productCall(origin, "/api/html");

      expect(refused.failure).toMatchObject({ stage: "before response", code: "ECONNREFUSED" });
      expect(reset.failure).toMatchObject({ stage: "before response", code: "ECONNRESET" });
      expect(midBody.failure).toMatchObject({ stage: "reading body", status: 200 });
      expect(html.failure).toMatchObject({ stage: "decoding body", status: 200 });
      expect(html.status).toBe(200);
      expect(reset.message).toMatch(
        /^POST \/api\/reset failed \(request\) before a JSON response was read: before response, [A-Za-z >]+ ECONNRESET, after \d+ ms/u,
      );
      expect(html.message).toContain(
        "POST /api/html returned HTTP 200 without a JSON response (text/html, ",
      );
      // The product client decodes with Schema, so the parser's error is a SchemaError.
      expect(html.message).toMatch(/: decoding body of HTTP 200, SchemaError, after \d+ ms/u);
      for (const error of [refused, reset, midBody, html])
        for (const text of renderings(error)) expect(leaked(text)).toEqual([]);
    }),
  );
});
