/**
 * An app's request Executor's network failed to send fails the app's `fetch`, as the platform's
 * own fetch does when its network fails, through every `fetch` app code can reach. Executor's
 * network never presents its own failure as a status the service could have sent, a service's
 * real answer still reaches the app unchanged, and Cloud reports only failures on Executor's
 * side, with a fixed category. The failure names no host: the app knows which request it sent,
 * and nothing Executor records about it, in Sentry or in traces, names the destination. On Cloud,
 * the outbound request's span records no part of the app's path.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { authoredAppFiles, openapiAppFiles } from "../support/authored-templates.ts";
import { egressUpstream } from "../support/egress-upstream.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import {
  SentryEvent,
  sentryEventText,
  sentryEvents,
  sentryExceptions,
} from "../support/sentry-events.ts";

const ToolFailed = Schema.Struct({
  _tag: Schema.Literal("ToolCallFailed"),
  failure: Schema.Struct({
    source: Schema.String,
    errorName: Schema.String,
    code: Schema.optional(Schema.String),
    message: Schema.String,
  }),
});
const ProviderFailed = Schema.Struct({
  _tag: Schema.Literal("AppProviderFailed"),
  reason: Schema.String,
  status: Schema.Number,
  message: Schema.String,
});
const EvaluationFailed = Schema.Struct({
  _tag: Schema.Literal("AppEvaluationFailed"),
  mcp: Schema.Struct({
    phase: Schema.String,
    reason: Schema.String,
    status: Schema.optional(Schema.Number),
  }),
  message: Schema.String,
});
const Answered = Schema.Struct({
  status: Schema.Number,
  unreachable: Schema.NullOr(Schema.String),
  text: Schema.String,
});

/**
 * The platform's `fetch` and the framework's `ctx.fetch`, as app code uses them, and the ways app
 * code could reach around the global it is given. An app with migrations owns a database, so its
 * queries run in the app's data facet, an isolate with its own global scope.
 */
const fetchApp = `import { defineApp, object, string, query, router } from "apps";
const answer = async (response) => ({ status: response.status, unreachable: response.headers.get("x-executor-unreachable"), text: await response.text() });
const input = { input: object({ url: string() }) };
export default defineApp({ accounts: {} }, {
  tools: router({
    global: query(input, async (_ctx, { url }) => answer(await fetch(url))),
    fetched: query(input, async (ctx, { url }) => answer(await ctx.fetch(url))),
    // The platform defines fetch on the global scope's prototype.
    inherited: query(input, async (_ctx, { url }) => {
      let scope = Object.getPrototypeOf(globalThis);
      while (!Object.hasOwn(scope, "fetch")) scope = Object.getPrototypeOf(scope);
      return answer(await scope.fetch.call(globalThis, url));
    }),
    deleted: query(input, async (_ctx, { url }) => {
      const own = Object.getOwnPropertyDescriptor(globalThis, "fetch");
      delete globalThis.fetch;
      try { return await answer(await fetch(url)); }
      finally { if (own !== undefined) Object.defineProperty(globalThis, "fetch", own); }
    }),
    // Built-ins replaced after load cannot hide a failed send.
    tampered: query(input, async (_ctx, { url }) => {
      const get = Headers.prototype.get;
      const status = Object.getOwnPropertyDescriptor(Response.prototype, "status");
      Headers.prototype.get = function () { return null; };
      Object.defineProperty(Response.prototype, "status", { ...status, get() { return 200; } });
      let response;
      try { response = await fetch(url); }
      finally { Headers.prototype.get = get; Object.defineProperty(Response.prototype, "status", status); }
      return answer(response);
    }),
  }),
});`;

/** One OpenAPI operation per path, named `service.<path>`. */
const document = (paths: ReadonlyArray<string>) => ({
  openapi: "3.1.0",
  info: { title: "Egress fixture", version: "1" },
  paths: Object.fromEntries(
    paths.map((path) => [
      `/${path}`,
      {
        get: {
          tags: ["service"],
          operationId: path,
          responses: { "200": { description: "Answered" } },
        },
      },
    ]),
  ),
});

const egressFailure = "AppEgressFailed";

layer(HostedLive, { excludeTestServices: true })("App egress failures", (it) => {
  it.effect(scenarios.appEgressFailures.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        const cloud = (yield* Target).metadata.target === "cloud";
        const upstream = yield* egressUpstream;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deploy = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
              name: `${name} ${randomUUID().slice(0, 8)}`,
              files,
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(App, deployed);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
            );
            return (tool: string, input: object) =>
              api.request(actors.owner, "POST", `${prefix}/${app.id}/tools/call`, {
                tool,
                kind: "query",
                input,
              });
          });
        const openapi = (name: string, origin: string, paths: ReadonlyArray<string>) =>
          deploy(
            name,
            openapiAppFiles(name, {
              url: { document: document(paths) },
              allowedOrigin: origin,
              baseUrl: origin,
              securitySchemes: {},
            }),
          );
        const fetching = yield* deploy("Egress fetch", [
          { path: "index.ts", content: fetchApp },
          appsManifest,
        ]);
        const facet = yield* deploy("Egress data", [
          { path: "index.ts", content: fetchApp },
          {
            path: "migrations/0001_marks.sql",
            content: "CREATE TABLE marks (label TEXT NOT NULL);\n",
          },
          appsManifest,
        ]);
        const service = yield* openapi("Egress service", upstream.origin, ["fail"]);
        const closed = yield* openapi("Egress closed", upstream.closedOrigin, ["ping"]);
        const mcp = yield* deploy(
          "Egress MCP",
          authoredAppFiles("mcp", upstream.closedOrigin, "public", "Egress MCP"),
        );
        const failed = <A, I>(
          schema: Schema.Codec<A, I>,
          response: { status: number; body: unknown },
        ) => {
          expect(response.status, JSON.stringify(response.body)).not.toBe(200);
          return body(schema, response);
        };
        const answered = (response: { status: number; body: unknown }) => {
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          return body(Answered, response);
        };
        const latestTrace = evidence.requests.pipe(
          Effect.map((requests) => {
            const id = requests.at(-1)?.traceId;
            if (id === undefined) throw new Error("The request trace was not recorded");
            return id;
          }),
        );

        // A service's own answers reach the app unchanged, including its server errors.
        const real500 = yield* answered(
          yield* fetching("global", { url: `${upstream.origin}/fail` }),
        );
        expect(real500).toEqual({
          status: 500,
          unreachable: null,
          text: JSON.stringify({ error: "synthetic outage" }),
        });
        const provider = yield* failed(ProviderFailed, yield* service("service.fail", {}));
        const providerTrace = yield* latestTrace;
        expect(provider).toMatchObject({ reason: "unavailable", status: 500 });
        expect(provider.message).toMatch(
          /^The connected service returned a server error \(HTTP 500\)/,
        );
        // A service cannot make the app's fetch fail by sending Executor's mark.
        expect(
          yield* answered(yield* fetching("global", { url: `${upstream.origin}/forged` })),
        ).toEqual({ status: 502, unreachable: null, text: "service answer" });

        // A send that fails before any answer rejects the app's fetch: never a status. The
        // message cannot claim the request was not sent: the connection may fail after it was.
        const networkMessage =
          "Executor's connection to the service failed before it answered. The request may have reached the service.";
        const rejected = { source: "app", errorName: "TypeError", message: networkMessage };
        const fetches: Record<string, unknown> = {};
        const fetchedTraces: Array<string> = [];
        // Every request that reached the closed port, for the telemetry checked below.
        const unsentTraces: Array<string> = [];
        for (const [isolate, call] of [
          ["rpc", fetching],
          ["facet", facet],
        ] as const) {
          for (const tool of ["global", "inherited", "deleted", "tampered"]) {
            const result = yield* failed(
              ToolFailed,
              yield* call(tool, { url: `${upstream.closedOrigin}/` }),
            );
            unsentTraces.push(yield* latestTrace);
            fetches[`${isolate}.${tool}`] = result;
            expect(result.failure, `${isolate}.${tool}`).toEqual(rejected);
          }
          // ctx.fetch's HTTP client names the transport failure and keeps the rejection as its cause.
          const fetched = yield* failed(
            ToolFailed,
            yield* call("fetched", { url: `${upstream.closedOrigin}/` }),
          );
          fetchedTraces.push(yield* latestTrace);
          fetches[`${isolate}.fetched`] = fetched;
          expect(fetched.failure, `${isolate}.fetched`).toEqual({
            source: "app",
            errorName: "HttpClientError",
            message: `Transport error (GET ${upstream.closedOrigin}/) (caused by TypeError: ${networkMessage})`,
          });
        }
        // The isolates still answer with the service's own responses afterwards.
        expect(
          yield* answered(yield* facet("tampered", { url: `${upstream.origin}/fail` })),
        ).toMatchObject({ status: 500, unreachable: null });
        const operation = yield* failed(ToolFailed, yield* closed("service.ping", {}));
        const operationTrace = yield* latestTrace;
        unsentTraces.push(...fetchedTraces, operationTrace);
        expect(operation.failure).toMatchObject({
          source: "service",
          errorName: "OpenapiError",
          code: "request",
        });
        expect(operation.failure.message).toContain("failed before a response arrived");

        // An MCP server that never answered is not reached, never a server error.
        const server = yield* failed(EvaluationFailed, yield* mcp("anything", {}));
        expect(server.mcp).toEqual({ phase: "transport", reason: "request" });
        expect(server.message).not.toMatch(/HTTP/);
        unsentTraces.push(yield* latestTrace);

        // The destination appears nowhere Executor records the failure: not in any exception a
        // trace records, nor in any Sentry event. The apps framework's HTTP client, used by ctx.fetch
        // and the OpenAPI helper, quotes the URL the app requested in its own error. Only that exact
        // text, in the records of those requests, is the app's; every other record, including any
        // AppEgressFailed report, is read whole.
        const transport = (path: string) => `Transport error (GET ${upstream.closedOrigin}${path})`;
        const appText = new Map([
          ...fetchedTraces.map((trace) => [trace, transport("/")] as const),
          [operationTrace, transport("/ping")],
        ]);
        /** `quotes`: the record is a failure the framework's HTTP client may have described. */
        type Recorded = { trace: string | undefined; quotes: boolean; text: string };
        const naming = (records: ReadonlyArray<Recorded>) =>
          records
            .filter(({ trace, quotes, text }) => {
              const quoted = quotes && trace !== undefined ? appText.get(trace) : undefined;
              return (quoted === undefined ? text : text.replaceAll(quoted, "")).includes(
                upstream.closedHost,
              );
            })
            .map(({ text }) => text);
        // The check still finds the host beside the app's text, in a report, or outside those traces.
        const [ownTrace, ownText] = [operationTrace, transport("/ping")];
        expect(
          naming([
            { trace: ownTrace, quotes: true, text: `${ownText} (caused by TypeError: failed)` },
            { trace: ownTrace, quotes: true, text: `${ownText} via ${upstream.closedHost}` },
            { trace: ownTrace, quotes: true, text: transport(`/ via ${upstream.closedHost}`) },
            { trace: ownTrace, quotes: false, text: ownText },
            { trace: providerTrace, quotes: true, text: ownText },
            { trace: undefined, quotes: true, text: ownText },
          ]),
        ).toEqual([
          `${ownText} via ${upstream.closedHost}`,
          transport(`/ via ${upstream.closedHost}`),
          ownText,
          ownText,
          ownText,
        ]);
        const traced = yield* Effect.forEach(unsentTraces, (trace) =>
          telemetry.query(trace).pipe(
            Effect.flatMap((result) =>
              result.data.some(({ span }) => span.operationName.startsWith("http.server")) &&
              result.data.some(({ span }) =>
                span.events.some((event) => event.name === "exception"),
              )
                ? Effect.succeed(result)
                : Effect.fail(new Error(`The failure of trace ${trace} has not arrived`)),
            ),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
          ),
        );
        const tracedNaming = naming(
          traced.flatMap((result) =>
            result.data.flatMap(({ traceId, span }) => [
              ...span.events.flatMap((event) => {
                const quotes = !Object.values(event.attributes).includes(egressFailure);
                return Object.values(event.attributes).map((text) => ({
                  trace: traceId,
                  quotes,
                  text,
                }));
              }),
              ...(span.statusMessage === undefined
                ? []
                : [{ trace: traceId, quotes: true, text: span.statusMessage }]),
            ]),
          ),
        );

        // On Cloud a fetch the network rejects is Executor's failure, reported with a fixed
        // category; answers from the service's side are not. ctx.fetch and the protocol helpers
        // carry the app request's trace, so their reports are found by it (the platform's global
        // fetch starts its own). Local workerd rejects a closed port where Cloudflare answers 521.
        const closedTraces = [...fetchedTraces, operationTrace];
        const egress = cloud
          ? (yield* sentryExceptions.pipe(
              Effect.repeat({
                schedule: Schedule.spaced("100 millis"),
                until: (exceptions) =>
                  closedTraces.every((trace) =>
                    exceptions.some((item) => item.trace === trace && item.type === egressFailure),
                  ),
              }),
              Effect.timeout("10 seconds"),
            )).filter((item) => item.type === egressFailure)
          : [];
        const reported = Object.fromEntries(
          [...closedTraces, providerTrace].map((trace) => [
            trace,
            egress.filter((item) => item.trace === trace).map((item) => item.value),
          ]),
        );
        yield* evidence.json("egress.json", {
          real500,
          provider,
          fetches,
          operation,
          server,
          reported,
          tracedNaming,
        });
        expect(tracedNaming).toEqual([]);
        if (!cloud) return;
        // On Cloud each app request reaches Executor's outbound as a request of its own. The path is
        // the app's, so that request's span records only its route's template.
        const served = traced.flatMap((result) =>
          result.data
            .map(({ span }) => span)
            .filter((span) => span.operationName.startsWith("http.server")),
        );
        const outbound = served.filter((span) => span.tags["http.route"] === "/:upstream");
        expect(outbound.length).toBeGreaterThan(0);
        expect(new Set(outbound.map((span) => span.tags["url.path"]))).toEqual(
          new Set(["/:upstream"]),
        );
        expect(served.filter((span) => span.tags["url.path"] === "/ping")).toEqual([]);
        const SentryRecord = Schema.fromJsonString(
          Schema.Struct({
            exception: SentryEvent.fields.exception,
            contexts: SentryEvent.fields.contexts,
          }),
        );
        expect(
          naming(
            (yield* sentryEventText).map((text) => {
              const event = Schema.decodeUnknownSync(SentryRecord)(text);
              return {
                trace: event.contexts?.trace?.trace_id,
                quotes:
                  event.exception !== undefined &&
                  !event.exception.values.some((value) => value.type === egressFailure),
                text,
              };
            }),
          ),
        ).toEqual([]);
        for (const trace of closedTraces)
          expect(reported[trace]).toEqual([
            "Executor's app network could not send an app's request (connection_lost).",
          ]);
        expect(reported[providerTrace]).toEqual([]);
        // The report names no user or organization; its message above names no host or app.
        for (const event of (yield* sentryEvents).filter((event) =>
          event.exception?.values.some((value) => value.type === egressFailure),
        )) {
          expect(event.user).toBeUndefined();
          expect(event.tags?.organization_id).toBeUndefined();
        }
      }),
    ),
  );
});
