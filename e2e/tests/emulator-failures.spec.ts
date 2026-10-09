/**
 * An emulator call that fails names the endpoint, the emulator and emulators.dev's diagnostic
 * report, and nothing else. The instance URL is the only access control for its emulator, and an
 * error body can quote provider tokens, sign-in codes and addresses, so none of them may reach the
 * error, its rendering in result.json (`Cause.pretty`), or any span: attributes, events or status.
 * A local server stands in for emulators.dev and answers with synthetic secrets.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Exit, Tracer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { emulatorRequest } from "../support/emulators.ts";

const suffix = "0123456789abcdef01234567";
const instance = `report-${suffix}`;
const token = "emu_resend_SYNTHETICtoken0001";
const code = "SYNTH-CODE-482913";
const email = "pat.synthetic@example.test";
// Secrets shaped like diagnostic values: each passes a format check for the field it is in.
const named = "SYNTHETICtoken482913";
const secrets = [suffix, token, code, email, named, named.toUpperCase(), "482913482913"];
const ray = "8f1d2c3b4a5e6f70-PHX";

/** emulate's instance hash: the first 12 hex digits of SHA-256(`service:instance`). */
const instanceId = (name: string) =>
  createHash("sha256").update(`resend:${name}`).digest("hex").slice(0, 12);

const report = {
  error: "emulator_unavailable",
  service: "resend",
  instanceId: instanceId(instance),
  method: "GET",
  route: "/emails",
  errorClass: "Error",
  retryable: true,
  overloaded: false,
  remote: false,
};

/** Answers with the response named by the instance's prefix (`/resend/<case>-<suffix>/...`). */
const responses: Record<string, { status: number; headers: Record<string, string>; body: string }> =
  {
    // A report with the diagnostic fields plus everything an older or broken server might add.
    report: {
      status: 503,
      headers: { "content-type": "application/json", "cf-ray": ray },
      body: JSON.stringify({
        ...report,
        ray,
        message: `lost ${instance}: token ${token} code ${code} for ${email}`,
        stack: `Error: ${token}\n    at ${email}`,
        path: `/resend/${instance}/emails/${email}`,
        instance,
        token,
      }),
    },
    // Every field holds a secret that passes its format check; only the flags survive.
    tainted: {
      status: 500,
      headers: { "content-type": "application/json", "cf-ray": code },
      body: JSON.stringify({
        ...report,
        service: named,
        instanceId: "482913482913",
        method: named.toUpperCase(),
        route: `/emails/${named}`,
        errorClass: named,
        ray: code,
      }),
    },
    // A dynamic segment's name is the server's to choose, so it is not repeated.
    param: {
      status: 503,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...report, instanceId: undefined, route: `/:${named}` }),
    },
    // Cloudflare's opaque error page.
    opaque: {
      status: 500,
      headers: { "content-type": "text/html" },
      body: `<html>Worker threw exception for ${instance} ${token} ${code} ${email}</html>`,
    },
  };

const stub = Effect.acquireRelease(
  Effect.callback<{ readonly origin: string; readonly close: () => void }>((resume) => {
    const server = createServer((request, response) => {
      const name = (request.url ?? "").split("/")[2]?.split("-")[0] ?? "";
      const answer = responses[name] ?? { status: 404, headers: {}, body: "" };
      response.writeHead(answer.status, answer.headers).end(answer.body);
    });
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resume(Effect.succeed({ origin: `http://localhost:${port}`, close: () => server.close() }));
    });
  }),
  ({ close }) => Effect.sync(close),
);

/** Records every span the program starts, as an exporter would receive them. */
const recording = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const exported = () =>
    JSON.stringify(
      spans.map((span) => ({
        name: span.name,
        attributes: Object.fromEntries(span.attributes),
        events: span.events.map(([name, , attributes]) => ({ name, attributes })),
        status:
          span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
            ? Cause.pretty(span.status.exit.cause)
            : span.status._tag,
      })),
    );
  return { tracer, spans, exported };
};

const leaked = (text: string) => secrets.filter((secret) => text.includes(secret));

/** Calls the stub as the harness calls emulators.dev, inside a caller's span. */
const failingCall = (origin: string, name: string, tracer: Tracer.Tracer) =>
  emulatorRequest(`${origin}/resend/${name}-${suffix}`, "/emails", undefined, token).pipe(
    Effect.withSpan("harness step"),
    Effect.withTracer(tracer),
    Effect.flip,
    Effect.provide(FetchHttpClient.layer),
  );

layer(NodeServices.layer)("Emulator failures", (it) => {
  it.effect("a failure report keeps only emulate's diagnostic fields", () =>
    Effect.gen(function* () {
      const { origin } = yield* stub;
      const { tracer, spans, exported } = recording();
      const error = yield* failingCall(origin, "report", tracer);

      expect(error.message).toBe(
        `External emulator failed: GET /emails on resend/report-… #${instanceId(instance)} (HTTP 503, cf-ray ${ray}): emulator_unavailable at GET /emails, Error retryable`,
      );
      expect({ ...error.report }).toEqual(report);
      expect(spans.map((span) => span.name)).toEqual(["harness step"]);
      expect(leaked(error.message)).toEqual([]);
      expect(leaked(JSON.stringify(error))).toEqual([]);
      expect(leaked(Cause.pretty(Cause.fail(error)))).toEqual([]);
      expect(leaked(exported())).toEqual([]);
    }),
  );

  it.effect("a report field that is not a value the harness knows is dropped", () =>
    Effect.gen(function* () {
      const { origin } = yield* stub;
      const tainted = yield* failingCall(origin, "tainted", recording().tracer);
      expect({ ...tainted.report }).toEqual({
        error: "emulator_unavailable",
        retryable: true,
        overloaded: false,
        remote: false,
      });
      expect(tainted.message).toBe(
        `External emulator failed: GET /emails on resend/tainted-… #${instanceId(`tainted-${suffix}`)} (HTTP 500): emulator_unavailable, retryable`,
      );
      const param = yield* failingCall(origin, "param", recording().tracer);
      expect(param.report).toMatchObject({ route: "/:param", service: "resend" });
      expect(param.report?.instanceId).toBeUndefined();
      for (const error of [tainted, param]) {
        expect(leaked(error.message)).toEqual([]);
        expect(leaked(JSON.stringify(error))).toEqual([]);
      }
    }),
  );

  it.effect("a body or cf-ray that carries a secret is not reported", () =>
    Effect.gen(function* () {
      const { origin } = yield* stub;
      for (const name of ["tainted", "opaque"]) {
        const { tracer, exported } = recording();
        const error = yield* failingCall(origin, name, tracer);
        if (name === "opaque") expect(error.report).toBeUndefined();
        expect(error.status).toBe(500);
        expect(error.ray).toBeUndefined();
        expect(leaked(JSON.stringify(error))).toEqual([]);
        expect(leaked(Cause.pretty(Cause.fail(error)))).toEqual([]);
        expect(leaked(exported())).toEqual([]);
      }
    }),
  );

  it.effect("a request that never gets a response does not carry its URL", () =>
    Effect.gen(function* () {
      const { tracer, exported } = recording();
      // Nothing listens on port 9 (discard) here; the connection is refused.
      const error = yield* failingCall("http://localhost:9", "unreachable", tracer);
      expect(error.reason).toBe("request");
      expect(leaked(JSON.stringify(error))).toEqual([]);
      expect(leaked(Cause.pretty(Cause.fail(error)))).toEqual([]);
      expect(leaked(exported())).toEqual([]);
    }),
  );

  it.effect("the recorder sees the URL an ordinary traced request exports", () =>
    Effect.gen(function* () {
      const { origin } = yield* stub;
      const { tracer, exported } = recording();
      // The control: Effect's client span records `url.full`, which is why emulator calls turn it off.
      yield* HttpClient.get(`${origin}/resend/opaque-${suffix}/emails`).pipe(
        Effect.withTracer(tracer),
        Effect.provide(FetchHttpClient.layer),
      );
      expect(leaked(exported())).toContain(suffix);
    }),
  );
});
