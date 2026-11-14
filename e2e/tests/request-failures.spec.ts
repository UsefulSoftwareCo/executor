/**
 * A call that gets no usable response says how far it got: whether a response began, with which
 * status, whether it failed in transport or while decoding the body, the error tags and low-level
 * code, how long it ran, what the client saw (DNS, connect, TLS, reset, closed, time-out), and the
 * Cloudflare ray and location of any response that carried one. Calls to emulators.dev (`emulatorRequest`) and to the product or a
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
import { originUnreachable, preparationFailure } from "../sdk/prepare-scenarios.ts";
import { ScenarioPreparationFailed } from "../sdk/scenario.ts";
import { RequestFailed, SessionClients } from "../support/api.ts";
import { EmulatorDeadline, emulatorRequest } from "../support/emulators.ts";
import { failureText, stepFailureText } from "../support/failure-text.ts";
import { Target, withCause } from "../support/platform.ts";
import {
  CallFailed,
  connectionOf,
  isLost,
  parseJson,
  platformSignatures,
  readResponse,
} from "../support/request-failure.ts";

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
// A response that came through Cloudflare names its ray and location; nothing else in the header
// is kept, so a value that is not ray-shaped is dropped whole.
const ray = "8f0c1a2b3c4d5e6f";
const edgeHeaders = { "cf-ray": `${ray}-IAD` };
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
        ...edgeHeaders,
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
        .writeHead(200, { "content-type": "text/html", ...edgeHeaders })
        .end(`${bodyStart}<html>not json ${bodyValue}</html>`);
      return;
    case "runtime-502":
      // Cloudflare's Workers runtime answering for a Worker that did not: its own plain text.
      response
        .writeHead(502, { "content-type": "text/plain;charset=UTF-8", ...edgeHeaders })
        .end("Bad Gateway");
      return;
    case "runtime-502-html":
      // The same words as an HTML page: not the runtime's answer.
      response.writeHead(502, { "content-type": "text/html", ...edgeHeaders }).end("Bad Gateway");
      return;
    case "runtime-502-no-ray":
      // The same answer that did not come through Cloudflare.
      response.writeHead(502, { "content-type": "text/plain;charset=UTF-8" }).end("Bad Gateway");
      return;
    case "our-502":
      // Our own 502: a JSON error with its tag.
      response
        .writeHead(502, { "content-type": "application/json", ...edgeHeaders })
        .end(JSON.stringify({ _tag: "ToolCallFailed", message: "The upstream failed." }));
      return;
    case "html-odd-ray":
      // The same answer with a `cf-ray` that is not a ray.
      response
        .writeHead(200, { "content-type": "text/html", "cf-ray": `${ray}-IAD ${bodyValue}` })
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
/** A reserved name that never resolves (RFC 6761), so its lookup fails. */
const unresolvableOrigin = "http://executor-e2e.invalid";

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
  it("ETIMEDOUT is a connect failure before a response and a time-out once the body has begun", () => {
    expect(connectionOf("before response", "ETIMEDOUT")).toBe("connect");
    expect(connectionOf("reading body", "ETIMEDOUT")).toBe("timeout");
    // The other codes keep their kind whatever the stage.
    expect(connectionOf("reading body", "ECONNRESET")).toBe("reset");
    expect(connectionOf("before response", "ECONNREFUSED")).toBe("connect");
  });

  it.effect("an emulator call says how far it got before it failed", () =>
    Effect.gen(function* () {
      const { origin } = yield* stub;
      const refused = yield* emulatorCall(refusedOrigin, "/x");
      const reset = yield* emulatorCall(origin, "/reset");
      const closed = yield* emulatorCall(origin, "/closed");
      const midBody = yield* emulatorCall(origin, "/mid-body");
      const html = yield* emulatorCall(origin, "/html");
      const refusedBody = yield* emulatorCall(origin, "/mid-body-404");
      const oddRay = yield* emulatorCall(origin, "/html-odd-ray");
      const unresolvable = yield* emulatorCall(unresolvableOrigin, "/x");
      // TLS to a server that speaks plain HTTP: the handshake fails.
      const tls = yield* emulatorCall(origin.replace("http:", "https:"), "/x");
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
      // What the client saw, for each call that got no whole answer.
      expect(refused.failure?.connection).toBe("connect");
      expect(reset.failure?.connection).toBe("reset");
      expect(closed.failure?.connection).toBe("closed");
      expect(midBody.failure?.connection).toMatch(/^(?:closed|reset|other)$/u);
      expect(unresolvable.failure).toMatchObject({ stage: "before response", connection: "dns" });
      expect(tls.failure).toMatchObject({ stage: "before response", connection: "tls" });
      expect(html.failure?.connection).toBeUndefined();
      // The ray and location of every response that carried one, and only a ray-shaped one.
      expect(html.failure).toMatchObject({ ray, colo: "IAD" });
      expect(midBody.failure).toMatchObject({ ray, colo: "IAD" });
      expect(refusedBody.failure).toMatchObject({ ray, colo: "IAD" });
      expect(oddRay.failure).toMatchObject({ stage: "decoding body", status: 200 });
      expect(oddRay.failure?.ray).toBeUndefined();
      expect(oddRay.failure?.colo).toBeUndefined();
      for (const error of [refused, reset, closed, unresolvable, tls])
        expect(error.failure?.ray).toBeUndefined();
      for (const error of [oddRay, unresolvable, tls])
        for (const text of renderings(error)) expect(leaked(text)).toEqual([]);
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
        /^External emulator failed: POST \/reset on resend\/kind-… #[0-9a-f]{12} \(request: before response \(reset\), [A-Za-z >]+ ECONNRESET, after \d+ ms\)$/u,
      );
      expect(midBody.message).toMatch(
        /\(request: reading body of HTTP 200 \((?:closed|reset|other)\), .*, ray 8f0c1a2b3c4d5e6f-IAD\)$/u,
      );
      expect(html.message).toMatch(
        /\(request: decoding body of HTTP 200, SyntaxError, after \d+ ms, ray 8f0c1a2b3c4d5e6f-IAD\)$/u,
      );
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
        expect(stalled.failure).toMatchObject({ stage: "timeout", connection: "timeout" });
        expect(stalled.failure?.status).toBeUndefined();
        expect(headersOnly.reason).toBe("timeout");
        expect(headersOnly.failure).toMatchObject({
          stage: "timeout",
          status: 200,
          connection: "timeout",
        });
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

  it.effect(
    "a product call that failed in Cloudflare's platform says so first, and nothing else does",
    () =>
      Effect.gen(function* () {
        const { origin } = yield* stub;
        const runtime = yield* productCall(origin, "/api/runtime-502");
        const reset = yield* productCall(origin, "/api/reset");
        const closed = yield* productCall(origin, "/api/closed");
        const html = yield* productCall(origin, "/api/runtime-502-html");
        const noRay = yield* productCall(origin, "/api/runtime-502-no-ray");
        const refused = yield* productCall(refusedOrigin, "/api/x");
        const notJson = yield* productCall(origin, "/api/html");
        const emulatorReset = yield* emulatorCall(origin, "/reset");

        // Cloudflare's own 502: our Worker did not answer, and the ray says where to look.
        expect(runtime.failure).toMatchObject({
          status: 502,
          ray,
          colo: "IAD",
          signature: "runtime-502",
        });
        expect(runtime.message.split("\n")[0]).toMatch(
          /^Cloudflare's Workers runtime answered 502 Bad Gateway itself; our Worker did not answer \(ray 8f0c1a2b3c4d5e6f-IAD\): POST \/api\/runtime-502 returned HTTP 502 without a JSON response/u,
        );
        // A request lost before any response: what the client saw, and that nothing arrived.
        expect(reset.failure?.signature).toBe("lost");
        expect(reset.message).toMatch(
          /^Request lost before any response: the client saw the connection reset with no response after \d+ ms: POST \/api\/reset failed \(request\)/u,
        );
        expect(closed.failure?.signature).toBe("lost");
        expect(closed.message).toMatch(
          /^Request lost before any response: the client saw the connection closed with no response after \d+ ms: /u,
        );
        // Anything that is not exactly one of the two keeps its ordinary text.
        for (const error of [html, noRay, refused, notJson]) {
          expect(error.failure?.signature).toBeUndefined();
          for (const label of Object.values(platformSignatures))
            expect(error.message).not.toContain(label);
        }
        expect(refused.message).toMatch(/^POST \/api\/x failed \(request\)/u);
        // An emulator is not our Worker: its failures are never labelled as ours.
        for (const label of Object.values(platformSignatures))
          expect(emulatorReset.message).not.toContain(label);
        for (const error of [runtime, reset, closed])
          for (const text of renderings(error)) expect(leaked(text)).toEqual([]);
      }),
  );

  it.effect(
    "a request with no response headers before its deadline keeps its ordinary text",
    () =>
      Effect.gen(function* () {
        const { origin } = yield* stub;
        // As the API client's 60 s deadline would, shortened: the server never answers.
        const failure = yield* readResponse(
          Effect.flatMap(HttpClient.HttpClient, (http) =>
            http.execute(HttpClientRequest.get(`${origin}/stall`)),
          ),
          "1 second",
        ).pipe(Effect.scoped, Effect.flip, Effect.provide(FetchHttpClient.layer));
        expect(failure).toBeInstanceOf(CallFailed);
        if (!(failure instanceof CallFailed)) return;
        expect(failure.failure).toMatchObject({ stage: "timeout", connection: "timeout" });
        expect(failure.failure.status).toBeUndefined();
        expect(failure.failure.signature).toBeUndefined();
        const error = new RequestFailed({
          method: "GET",
          path: "/stall",
          reason: "timeout",
          failure: failure.failure,
        });
        expect(error.message).toMatch(
          /^GET \/stall failed \(timeout\) before a JSON response was read: timeout, after \d+ ms$/u,
        );
        for (const label of Object.values(platformSignatures))
          expect(error.message).not.toContain(label);
      }),
    { timeout: 10_000 },
  );

  it.effect("our own 502, a JSON error with its tag, is an answer and not a platform failure", () =>
    Effect.gen(function* () {
      const { origin } = yield* stub;
      const answer = yield* Effect.gen(function* () {
        const sessions = yield* SessionClients;
        const session = yield* sessions.session();
        return yield* sessions.request(session, "POST", "/api/our-502", {});
      }).pipe(
        Effect.provide(
          SessionClients.layer.pipe(Layer.provide([targetAt(origin), FetchHttpClient.layer])),
        ),
      );
      expect(answer.status).toBe(502);
      expect(answer.body).toMatchObject({ _tag: "ToolCallFailed" });
    }),
  );

  it("a lost request is one with no response headers whose connection was reset or closed", () => {
    const base = { elapsedMs: 10 } as const;
    expect(isLost({ ...base, stage: "before response", connection: "reset" })).toBe(true);
    expect(isLost({ ...base, stage: "before response", connection: "closed" })).toBe(true);
    // A deadline is not evidence of the platform: our own Worker hanging looks the same.
    expect(isLost({ ...base, stage: "before response", connection: "timeout" })).toBe(false);
    expect(isLost({ ...base, stage: "timeout", connection: "timeout" })).toBe(false);
    // Headers arrived, or the connection was never made: not lost.
    expect(isLost({ ...base, stage: "timeout", status: 200, connection: "timeout" })).toBe(false);
    expect(isLost({ ...base, stage: "reading body", status: 200, connection: "closed" })).toBe(
      false,
    );
    for (const connection of ["connect", "dns", "tls", "other"] as const)
      expect(isLost({ ...base, stage: "before response", connection })).toBe(false);
  });

  it("an app origin no HTTPS connection reached says so first, with the run's other origins", () => {
    const run = { origins: 26, readyElapsedMs: [104_259, 147_191, 191_160] };
    const neverAnswered = {
      attempts: 149,
      ready: false,
      elapsedMs: 298_994,
      lastFailure: { reason: "transport" as const },
      coordinator: {
        status: "pending" as const,
        certificate: "pending_validation",
        since: "2026-01-01T00:00:00.000Z",
      },
    };
    const unreachable = originUnreachable(neverAnswered, run);
    expect(unreachable).toEqual({
      attempts: 149,
      waitedMs: 298_994,
      readyOrigins: 3,
      origins: 26,
      slowestReadyMs: 191_160,
      certificate: "pending_validation",
      since: "2026-01-01T00:00:00.000Z",
    });
    const failed = new ScenarioPreparationFailed({ reason: "domain_unavailable", unreachable });
    expect(failed.message).toBe(
      "No HTTPS connection to the scenario's app origin completed within the infrastructure wait (149 attempts in 299 s); 3 of the run's 26 app origins became ready, the slowest after 191 s. The domain coordinator last saw its certificate pending_validation since 2026-01-01T00:00:00.000Z.",
    );
    // Without the coordinator's record, and with no other origin ready.
    const { coordinator: _none, ...unrecorded } = neverAnswered;
    expect(
      new ScenarioPreparationFailed({
        reason: "domain_unavailable",
        unreachable: originUnreachable(unrecorded, { origins: 1, readyElapsedMs: [] }),
      }).message,
    ).toBe(
      "No HTTPS connection to the scenario's app origin completed within the infrastructure wait (149 attempts in 299 s); none of the run's 1 app origins became ready.",
    );

    // A stage whose coordinator reports a status but no certificate state: the same, no clause.
    expect(
      new ScenarioPreparationFailed({
        reason: "domain_unavailable",
        unreachable: originUnreachable(
          { ...unrecorded, coordinator: { status: "pending" as const } },
          run,
        ),
      }).message,
    ).toBe(
      "No HTTPS connection to the scenario's app origin completed within the infrastructure wait (149 attempts in 299 s); 3 of the run's 26 app origins became ready, the slowest after 191 s.",
    );

    // An origin that answered and was not reported ready may be ours: it keeps its own text.
    const answered = {
      attempts: 40,
      ready: false,
      elapsedMs: 298_000,
      httpsMs: 90_000,
      reported: "pending" as const,
    };
    // So does one whose last failure was an HTTP status or the per-attempt deadline.
    const refused = { ...neverAnswered, lastFailure: { reason: "http" as const, status: 502 } };
    const slow = { ...neverAnswered, lastFailure: { reason: "timeout" as const } };
    for (const observation of [answered, refused, slow, undefined]) {
      expect(originUnreachable(observation, run)).toBeUndefined();
    }
    const ordinary = new ScenarioPreparationFailed({ reason: "domain_unavailable" });
    expect(ordinary.message).toBe(
      "The scenario's HTTPS app origin did not answer, or was not reported ready, within the infrastructure deadline",
    );
    for (const label of Object.values(platformSignatures))
      expect(ordinary.message).not.toContain(label);
  });

  it.effect("a product call says how far it got before it failed", () =>
    Effect.gen(function* () {
      const { origin } = yield* stub;
      const refused = yield* productCall(refusedOrigin, "/api/x");
      const reset = yield* productCall(origin, "/api/reset");
      const midBody = yield* productCall(origin, "/api/mid-body");
      const html = yield* productCall(origin, "/api/html");

      expect(refused.failure).toMatchObject({
        stage: "before response",
        code: "ECONNREFUSED",
        connection: "connect",
      });
      expect(reset.failure).toMatchObject({
        stage: "before response",
        code: "ECONNRESET",
        connection: "reset",
      });
      expect(midBody.failure).toMatchObject({
        stage: "reading body",
        status: 200,
        ray,
        colo: "IAD",
      });
      expect(html.failure).toMatchObject({ stage: "decoding body", status: 200, ray, colo: "IAD" });
      expect(html.status).toBe(200);
      expect(reset.message).toMatch(
        /^Request lost before any response: the client saw the connection reset with no response after \d+ ms: POST \/api\/reset failed \(request\) before a JSON response was read: before response \(reset\), [A-Za-z >]+ ECONNRESET, after \d+ ms/u,
      );
      expect(html.message).toContain(
        "POST /api/html returned HTTP 200 without a JSON response (text/html, ",
      );
      // The product client decodes with Schema, so the parser's error is a SchemaError.
      expect(html.message).toMatch(
        /: decoding body of HTTP 200, SchemaError, after \d+ ms, ray 8f0c1a2b3c4d5e6f-IAD/u,
      );
      for (const error of [refused, reset, midBody, html])
        for (const text of renderings(error)) expect(leaked(text)).toEqual([]);
    }),
  );
});
