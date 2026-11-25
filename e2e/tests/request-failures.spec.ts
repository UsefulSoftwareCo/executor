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
const bodyStart = "SYNTHMK7Q2";
const secrets = [suffix, token, queryValue, bodyValue, bodyStart];
const parserWords = ["not valid JSON", "Unexpected token", "Unexpected end"];
const ray = "8f0c1a2b3c4d5e6f";
const edgeHeaders = { "cf-ray": `${ray}-IAD` };
const leaked = (text: string) =>
  [...secrets, ...parserWords].filter((secret) => text.includes(secret));

const failing = (request: IncomingMessage, response: ServerResponse): void => {
  const kind = (request.url ?? "").split("?")[0]?.split("/").at(-1) ?? "";
  const socket = response.socket;
  switch (kind) {
    case "reset":
      socket?.resetAndDestroy();
      return;
    case "closed":
      socket?.destroy();
      return;
    case "mid-body":
    case "mid-body-404": {
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
      response
        .writeHead(200, { "content-type": "text/html", ...edgeHeaders })
        .end(`${bodyStart}<html>not json ${bodyValue}</html>`);
      return;
    case "runtime-502":
      response
        .writeHead(502, { "content-type": "text/plain;charset=UTF-8", ...edgeHeaders })
        .end("Bad Gateway");
      return;
    case "runtime-502-html":
      response.writeHead(502, { "content-type": "text/html", ...edgeHeaders }).end("Bad Gateway");
      return;
    case "runtime-502-no-ray":
      response.writeHead(502, { "content-type": "text/plain;charset=UTF-8" }).end("Bad Gateway");
      return;
    case "our-502":
      response
        .writeHead(502, { "content-type": "application/json", ...edgeHeaders })
        .end(JSON.stringify({ _tag: "ToolCallFailed", message: "The upstream failed." }));
      return;
    case "html-odd-ray":
      response
        .writeHead(200, { "content-type": "text/html", "cf-ray": `${ray}-IAD ${bodyValue}` })
        .end(`${bodyStart}<html>not json ${bodyValue}</html>`);
      return;
    case "empty":
      response.writeHead(200, { "content-type": "application/json" }).end();
      return;
    case "headers-then-stall":
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      return;
    case "stall":
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
      const tls = yield* emulatorCall(origin.replace("http:", "https:"), "/x");
      const empty = yield* emulatorRequest(`${origin}/resend/kind-${suffix}`, "/empty").pipe(
        Effect.provide(FetchHttpClient.layer),
      );

      expect(empty).toBeNull();
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
      expect(refused.failure?.connection).toBe("connect");
      expect(reset.failure?.connection).toBe("reset");
      expect(closed.failure?.connection).toBe("closed");
      expect(midBody.failure?.connection).toMatch(/^(?:closed|reset|other)$/u);
      expect(unresolvable.failure).toMatchObject({ stage: "before response", connection: "dns" });
      expect(tls.failure).toMatchObject({ stage: "before response", connection: "tls" });
      expect(html.failure?.connection).toBeUndefined();
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

        expect(runtime.failure).toMatchObject({
          status: 502,
          ray,
          colo: "IAD",
          signature: "runtime-502",
        });
        expect(runtime.message.split("\n")[0]).toMatch(
          /^Cloudflare's Workers runtime answered 502 Bad Gateway itself; our Worker did not answer \(ray 8f0c1a2b3c4d5e6f-IAD\): POST \/api\/runtime-502 returned HTTP 502 without a JSON response/u,
        );
        expect(reset.failure?.signature).toBe("lost");
        expect(reset.message).toMatch(
          /^Request lost before any response: the client saw the connection reset with no response after \d+ ms: POST \/api\/reset failed \(request\)/u,
        );
        expect(closed.failure?.signature).toBe("lost");
        expect(closed.message).toMatch(
          /^Request lost before any response: the client saw the connection closed with no response after \d+ ms: /u,
        );
        for (const error of [html, noRay, refused, notJson]) {
          expect(error.failure?.signature).toBeUndefined();
          for (const label of Object.values(platformSignatures))
            expect(error.message).not.toContain(label);
        }
        expect(refused.message).toMatch(/^POST \/api\/x failed \(request\)/u);
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
    expect(isLost({ ...base, stage: "before response", connection: "timeout" })).toBe(false);
    expect(isLost({ ...base, stage: "timeout", connection: "timeout" })).toBe(false);
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
    const { coordinator: _none, ...unrecorded } = neverAnswered;
    expect(
      new ScenarioPreparationFailed({
        reason: "domain_unavailable",
        unreachable: originUnreachable(unrecorded, { origins: 1, readyElapsedMs: [] }),
      }).message,
    ).toBe(
      "No HTTPS connection to the scenario's app origin completed within the infrastructure wait (149 attempts in 299 s); none of the run's 1 app origins became ready.",
    );

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

    const answered = {
      attempts: 40,
      ready: false,
      elapsedMs: 298_000,
      httpsMs: 90_000,
      reported: "pending" as const,
    };
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
      expect(html.message).toMatch(
        /: decoding body of HTTP 200, SchemaError, after \d+ ms, ray 8f0c1a2b3c4d5e6f-IAD/u,
      );
      for (const error of [refused, reset, midBody, html])
        for (const text of renderings(error)) expect(leaked(text)).toEqual([]);
    }),
  );
});
