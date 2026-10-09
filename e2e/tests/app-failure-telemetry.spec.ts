/**
 * An app can fail with any text: in its own error's name, code, fields, message and stack, outside
 * its error handling, in a reply the host cannot read, and in the spans and logs its isolate
 * returns, which its code can rewrite, in a reply naming an MCP status that is no HTTP status,
 * and in a workflow step. A caller's invalid input is described with its keys and paths and the
 * schema's keys and patterns. The app's own error and the input's problems reach the caller.
 * Executor's spans, logs and incident reports record only fixed descriptions and closed kinds,
 * never the app's or the caller's text.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, type SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { awaitSentryEvents, traceEvents } from "../support/sentry-events.ts";
import { appsManifest } from "../support/apps-release.ts";

/** The app's error message: its text, then a line shaped like a stack frame. */
const thrownMessage = (marker: string) =>
  `${marker}\n    at ${marker} (https://${marker}.example/app.js:1:1)`;

/**
 * The app throws its own error class, named for the marker, with the marker as its code, a field,
 * its message and an eval frame in its stack, from a function named for the marker. Outside its
 * error handling, the RPC bridge reads each reply through `Response.prototype.json` and the
 * framework answers through `Response.json`: one reply then rejects the call with the app's text,
 * one fails decoding, one names an MCP failure whose status is the numeric marker, and one fails
 * after the tool returned, in the framework's request handler. After one successful call, the
 * runtime's cancel of the finished call throws the app's text from `AbortController#abort`.
 */
const failing = (marker: string, status: number) => `
const marker = ${JSON.stringify(marker)};
class Failure extends Error {
  constructor() {
    super(${JSON.stringify(thrownMessage(marker))});
    this.name = marker;
    this.code = marker;
    this.detail = marker;
    this.stack = marker + ": " + marker +
      "\\n    at eval (eval at " + marker + " (https://" + marker + ".example/app.js:1:1), <anonymous>:1:1)";
  }
}
const thrown = { [marker]: async () => { throw new Failure(); } }[marker];
const json = Response.prototype.json;
Response.prototype.json = async function () {
  const value = await json.call(this);
  const text = JSON.stringify(value);
  if (text.includes("reply-" + "rejected")) throw new Error(marker);
  if (text.includes("reply-" + "malformed"))
    return { ok: false, error: { _tag: "HostOperationFailed", source: marker, errorName: marker, message: marker } };
  if (text.includes("reply-" + "mcp"))
    return { ok: false, error: { _tag: "McpError", phase: "call", reason: "request", status: ${status} } };
  return value;
};
const answer = Response.json;
Response.json = function (data, init) {
  if (JSON.stringify(data).includes("reply-" + "unanswered")) throw new Error(marker);
  return answer.call(this, data, init);
};
const dispatched = new WeakSet();
const Dispatch = Request;
globalThis.Request = class extends Dispatch {
  constructor(input, init) {
    super(input, init);
    if (String(input).endsWith("/dispatch") && init?.signal) dispatched.add(init.signal);
  }
};
let releasing = false;
const abort = AbortController.prototype.abort;
AbortController.prototype.abort = function (...args) {
  if (releasing && dispatched.has(this.signal)) {
    releasing = false;
    throw new Error(marker);
  }
  return abort.apply(this, args);
};
const released = async () => {
  releasing = true;
  return "released";
};
`;

/**
 * Any code in the isolate can rewrite the records it returns. This app adds the marker to every
 * span as attributes, an event, an exception, a link, a status message and trace state, adds a
 * span named for it beside each call, and puts it in every log record's body, level and
 * attributes.
 */
const hostile = `
const stringify = JSON.stringify;
const text = (value) => ({ stringValue: value });
const stack = marker + ": " + marker + "\\n    at " + marker + " (https://" + marker + ".example/app.js:1:1)";
JSON.stringify = function (value, ...rest) {
  if (value !== null && typeof value === "object" && typeof value.spanId === "string" && typeof value.startTimeUnixNano === "string") {
    const span = stringify.call(this, {
      ...value,
      attributes: [
        ...(value.attributes ?? []),
        { key: marker, value: text(marker) },
        { key: "error.type", value: text(marker) },
        { key: "executor.failure.code", value: text(marker) },
        { key: "executor.operation", value: text(marker) },
        { key: "executor.tool.name", value: text(marker) },
        { key: "url.path", value: text("/" + marker) },
        { key: "server.address", value: text(marker + ".example") },
        { key: "db.query.text", value: text("select '" + marker + "'") },
        { key: "http.response.status_code", value: text(marker) },
      ],
      events: [
        ...(value.events ?? []),
        { name: marker, timeUnixNano: value.startTimeUnixNano, attributes: [{ key: marker, value: text(marker) }] },
        {
          name: "exception",
          timeUnixNano: value.startTimeUnixNano,
          attributes: [
            { key: "exception.type", value: text(marker) },
            { key: "exception.message", value: text(marker) },
            { key: "exception.stacktrace", value: text(stack) },
          ],
        },
      ],
      links: [{ traceId: value.traceId, spanId: value.spanId, attributes: [{ key: marker, value: text(marker) }] }],
      status: { ...value.status, message: marker },
      traceState: marker,
    }, ...rest);
    if (value.name !== "app.call") return span;
    return span + "," + stringify.call(this, {
      traceId: value.traceId,
      spanId: "0123456789abcdef",
      parentSpanId: value.spanId,
      name: marker,
      kind: 1,
      startTimeUnixNano: value.startTimeUnixNano,
      endTimeUnixNano: value.endTimeUnixNano,
      attributes: [{ key: "executor.operation", value: text("call") }, { key: marker, value: text(marker) }],
      status: { code: 1, message: marker },
    });
  }
  if (value !== null && typeof value === "object" && typeof value.severityNumber === "number")
    return stringify.call(this, {
      ...value,
      severityText: marker,
      body: text(marker),
      attributes: [{ key: marker, value: text(marker) }, { key: "log.error", value: text(stack) }],
    }, ...rest);
  return stringify.call(this, value, ...rest);
};
`;

const source = (marker: string, status: number, rewritesTelemetry: boolean) => [
  {
    path: "index.ts",
    content: `import { defineApp, query, object, string, jsonSchema, router, workflow, NonRetryableError } from "apps";
${failing(marker, status)}
${rewritesTelemetry ? hostile : ""}
export default defineApp({ accounts: {} }, {
  tools: router({
    thrown: query({ input: object({}) }, thrown),
    rejected: query({ input: object({}), output: string() }, async () => "reply-" + "rejected"),
    malformed: query({ input: object({}), output: string() }, async () => "reply-" + "malformed"),
    unanswered: query({ input: object({}), output: string() }, async () => "reply-" + "unanswered"),
    mcp: query({ input: object({}), output: string() }, async () => "reply-" + "mcp"),
    released: query({ input: object({}), output: string() }, released),
    invalid: query({ input: jsonSchema({ type: "object", required: [marker], properties: { [marker]: { type: "string" }, slug: { type: "string", pattern: "^" + marker + "$" } } }) }, async () => "invalid"),
  }),
  workflows: {
    failing: workflow({ input: object({}) }, async (ctx) =>
      ctx.step.do("fails", { retries: { limit: 0, delay: 0 } }, async () => {
        throw new NonRetryableError(marker);
      })),
  },
});`,
  },
  appsManifest,
];

const ToolFailed = Schema.Struct({
  _tag: Schema.Literal("ToolCallFailed"),
  reason: Schema.String,
  failure: Schema.Struct({
    source: Schema.String,
    errorName: Schema.String,
    code: Schema.String,
    message: Schema.String,
    fields: Schema.Record(Schema.String, Schema.String),
  }),
});
const McpCallFailed = Schema.Struct({
  _tag: Schema.Literal("ToolCallFailed"),
  reason: Schema.String,
  mcp: Schema.Struct({ phase: Schema.String, reason: Schema.String, status: Schema.Number }),
});
const WorkflowRun = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  error: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(
    Schema.Struct({
      step: Schema.optionalKey(Schema.String),
      errorName: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
    }),
  ),
});
const InputRejected = Schema.Struct({
  _tag: Schema.Literal("InputInvalid"),
  problems: Schema.Array(Schema.String),
  message: Schema.String,
});
const EvaluationFailed = Schema.Struct({
  _tag: Schema.Literal("AppEvaluationFailed"),
  reason: Schema.String,
  message: Schema.String,
});
const DeliveredLogs = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        serviceName: Schema.String,
        severityText: Schema.optional(Schema.NullOr(Schema.String)),
        body: Schema.Unknown,
        attributes: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  }),
);

/** What the host records for an exception from an app isolate, whatever the isolate sent. */
const appException = (type: string) => ({
  name: "exception",
  attributes: {
    "exception.type": type,
    "exception.message": "Text from the app is not recorded",
    "exception.stacktrace": `${type}: Text from the app is not recorded`,
  },
});
type Delivered = (typeof SpanQuery.Type)["data"][number];

/**
 * The resource the host supplies for every record it forwards from an app isolate, including the
 * build that ran and the ID of the app it invoked, from the host's own invocation.
 */
const resource = [
  "service.name",
  "service.version",
  "deployment.environment.name",
  "executor.build.id",
  "executor.app.id",
];
const resourceTags = (app: string) => ({
  "service.name": "executor-app",
  "service.version": expect.any(String),
  "deployment.environment.name": expect.any(String),
  "executor.build.id": expect.any(String),
  "executor.app.id": app,
});

layer(HostedLive, { excludeTestServices: true })("App failure telemetry", (it) => {
  it.effect(scenarios.appFailureTelemetry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          target = yield* Target,
          fs = yield* FileSystem.FileSystem;
        const cloud = target.metadata.target === "cloud";
        // Also a valid JavaScript identifier, so the app can name a function for it.
        const marker = `synthetic_app_secret_${randomUUID().replaceAll("-", "")}`;
        // An MCP status no HTTP response can have, which released protocols still accept.
        const status = 800_000_000_000 + Math.floor(Math.random() * 99_999_999_999);
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deploy = (rewritesTelemetry: boolean) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
              name: `Failure text ${randomUUID().slice(0, 8)}`,
              files: source(marker, status, rewritesTelemetry),
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(App, deployed);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });

        /**
         * Call a tool, then read its trace once the host has recorded the failed call and has
         * forwarded the app isolate's spans and logs for it.
         */
        const call = (app: string, tool: string, input: object = {}) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/${app}/tools/call`,
              {
                tool,
                kind: "query",
                input,
              },
            );
            const trace = (yield* evidence.requests).at(-1)?.traceId;
            if (trace === undefined) return yield* Effect.die("The call's trace was not recorded");
            const delivered = Effect.gen(function* () {
              const spans = (yield* telemetry.query(trace)).data;
              const logs = yield* telemetry.logs(trace, marker);
              const appLogs = (yield* Schema.decodeUnknownEffect(DeliveredLogs)(
                logs[0],
              )).data.filter(({ serviceName }) => serviceName === "executor-app");
              const has = (name: string) => spans.some(({ span }) => span.operationName === name);
              const ready =
                spans.some(
                  ({ span }) =>
                    span.operationName === "sdk.tools.call" &&
                    span.status === (tool === "released" ? "ok" : "error"),
                ) &&
                // The finished call's release runs after its response.
                (!cloud || tool !== "released" || has("runtime.app.rpc.release")) &&
                // Cloud's app runner joins the caller's trace; wait for its invocation too.
                (!cloud || has("runtime.app.invoke")) &&
                // A rejected or unreadable reply carries no telemetry from the isolate.
                (tool !== "thrown" || has("app.call")) &&
                (tool !== "invalid" || has("app.dispatch")) &&
                (tool !== "unanswered" || (has("app.dispatch") && appLogs.length > 0));
              return ready
                ? { spans, logs, appLogs }
                : yield* Effect.fail(new Error(`The ${tool} call's trace has not been delivered`));
            });
            const found = yield* delivered.pipe(
              Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
            );
            return { response, trace, ...found };
          });
        const appSpans = (spans: ReadonlyArray<Delivered>) =>
          spans.filter(({ span }) => span.serviceName === "executor-app");
        const named = (spans: ReadonlyArray<Delivered>, name: string) =>
          spans.filter(({ span }) => span.operationName === name).map(({ span }) => span);

        const ordinary = yield* deploy(false);
        const thrown = yield* call(ordinary.id, "thrown");
        const rejected = yield* call(ordinary.id, "rejected");
        const malformed = yield* call(ordinary.id, "malformed");
        const unanswered = yield* call(ordinary.id, "unanswered");
        const mcp = yield* call(ordinary.id, "mcp");
        const released = yield* call(ordinary.id, "released");
        // The input nests the schema's key in a caller's key, which its problem names as a
        // place the key may have come from, and misses the schema's pattern.
        const callerKey = `in_${marker}`;
        const invalid = yield* call(ordinary.id, "invalid", {
          [callerKey]: { [marker]: "value" },
          slug: "value",
        });
        const rewriting = yield* deploy(true);
        const rewritten = yield* call(rewriting.id, "thrown");
        const rewrittenLog = yield* call(rewriting.id, "unanswered");

        // A workflow step throws the app's error. The run's owner reads it; the run's spans and
        // incident reports name only the failure's reason. Cloud carries the failure from the
        // app's runner back to its own step as an error; self-host's runner hands the host the
        // run's result as data, so no self-host span records a workflow failure.
        const runs = `${prefix}/${ordinary.id}/workflow-runs`;
        const started = yield* api.request(actors.owner, "POST", runs, {
          workflow: "failing",
          input: {},
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const runId = (yield* body(WorkflowRun, started)).id;
        const failedRun = yield* api.request(actors.owner, "GET", `${runs}/${runId}`).pipe(
          Effect.flatMap((response) => body(WorkflowRun, response)),
          Effect.flatMap((run) =>
            run.status === "errored"
              ? Effect.succeed(run)
              : Effect.fail(new Error(`The workflow run is ${run.status}`)),
          ),
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 200 }),
        );
        const workflowTrace = Effect.gen(function* () {
          const traces = new Set(
            (yield* telemetry.search("workflow.run", { "executor.run.id": runId })).data.map(
              ({ traceId }) => traceId,
            ),
          );
          const spans = (yield* Effect.forEach([...traces], (id) => telemetry.query(id))).flatMap(
            ({ data }) => data,
          );
          const failedIn = (name: string) =>
            spans.some(({ span }) => span.operationName === name && span.status === "error");
          const [trace] = traces;
          return trace !== undefined && failedIn("workflow.run") && failedIn("workflow.step")
            ? { trace, spans, logs: yield* telemetry.logs(trace, marker) }
            : yield* Effect.fail(new Error("The workflow run's spans have not been delivered"));
        }).pipe(Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }));
        const workflowRun = cloud ? yield* workflowTrace : undefined;
        const calls = {
          thrown,
          rejected,
          malformed,
          unanswered,
          mcp,
          released,
          invalid,
          rewritten,
          rewrittenLog,
          ...(workflowRun === undefined ? {} : { workflowRun }),
        };
        const sentry = cloud
          ? yield* awaitSentryEvents((events) =>
              Object.entries(calls).every(
                ([name, { trace }]) =>
                  name === "released" ||
                  name === "invalid" ||
                  traceEvents(events, trace).length > 0,
              ),
            ).pipe(
              Effect.flatMap((events) =>
                fs
                  .readFileString(`${target.directory}/sentry.ndjson`)
                  .pipe(Effect.map((raw) => ({ events, raw }))),
              ),
            )
          : undefined;
        yield* evidence.json("app-failure-telemetry.json", {
          responses: Object.fromEntries(
            Object.entries({
              thrown,
              rejected,
              malformed,
              unanswered,
              mcp,
              released,
              invalid,
              rewritten,
              rewrittenLog,
            }).map(([name, { response }]) => [
              name,
              { status: response.status, body: response.body },
            ]),
          ),
          workflowRun: failedRun,
          spans: Object.fromEntries(
            Object.entries(calls).map(([name, { spans }]) => [name, spans]),
          ),
          logs: Object.fromEntries(Object.entries(calls).map(([name, { logs }]) => [name, logs])),
        });

        // The app's own error reaches its caller, named as the app's: its name, code, field and
        // message, with the line shaped like a frame.
        for (const failed of [thrown, rewritten]) {
          expect(failed.response.status).toBe(502);
          const toolFailure = yield* body(ToolFailed, failed.response);
          expect(toolFailure.failure).toEqual({
            source: "app",
            errorName: marker,
            code: marker,
            message: thrownMessage(marker),
            fields: { detail: marker },
          });
          expect(toolFailure.reason).toBe(
            `The app threw ${marker} (${marker}): ${thrownMessage(marker)} Details: detail: "${marker}".`,
          );
        }
        // A rejected call, a reply that fails decoding and a failure after the tool returned: the
        // caller gets the generic failure.
        for (const failed of [rejected, malformed, unanswered, rewrittenLog]) {
          expect(failed.response.status).toBe(502);
          expect(yield* body(EvaluationFailed, failed.response)).toMatchObject({
            reason: "App evaluation failed",
            message: "Executor could not load this app’s tool definitions.",
          });
          expect(JSON.stringify(failed.response.body)).not.toContain(marker);
        }
        // The MCP failure's caller reads the status the app's reply named.
        expect(mcp.response.status).toBe(502);
        const mcpFailure = yield* body(McpCallFailed, mcp.response);
        expect(mcpFailure.mcp).toEqual({ phase: "call", reason: "request", status });
        expect(mcpFailure.reason).toContain(`(HTTP ${status})`);
        // The caller reads the input's problems, with its own key and the schema's pattern.
        expect(invalid.response.status, JSON.stringify(invalid.response.body)).toBe(422);
        const inputProblems = [
          `input.${marker}: Missing key. Expected string. The input has ${marker} at input.${callerKey}.${marker}; did you mean input.${marker}?`,
          `input.slug: Expected a string matching the pattern "^${marker}$"`,
        ];
        expect(yield* body(InputRejected, invalid.response)).toEqual({
          _tag: "InputInvalid",
          problems: inputProblems,
          message: `Input failed validation: ${inputProblems.join("; ")}`,
        });
        // A call whose release failed has already answered its caller.
        expect(released.response.status, JSON.stringify(released.response.body)).toBe(200);
        // The run's owner reads the failing step and the app's own error.
        expect(failedRun).toMatchObject({
          error: "execution",
          failure: { step: "fails", errorName: "NonRetryableError", message: marker },
        });

        // Each forwarded record names the app the host invoked: its evaluation, its calls and its
        // logs, whatever app ran before it.
        const invoked = (name: string) =>
          name === "rewritten" || name === "rewrittenLog" ? rewriting.id : ordinary.id;
        for (const [name, { spans }] of Object.entries(calls))
          expect(
            appSpans(spans).map(({ span }) => [span.operationName, span.tags["executor.app.id"]]),
            `${name}: each forwarded span names the invoked app`,
          ).toEqual(appSpans(spans).map(({ span }) => [span.operationName, invoked(name)]));
        for (const [name, { spans }] of [
          ["thrown", thrown],
          ["rewritten", rewritten],
        ] as const)
          expect(
            named(spans, "app.evaluate").length,
            `${name}: the app's evaluation was forwarded`,
          ).toBeGreaterThan(0);
        for (const [name, { appLogs }] of [
          ["unanswered", unanswered],
          ["rewrittenLog", rewrittenLog],
        ] as const)
          expect(
            appLogs.map(({ attributes }) => attributes["executor.app.id"]),
            `${name}: each forwarded log names the invoked app`,
          ).toEqual([invoked(name)]);

        for (const [name, { spans, logs }] of Object.entries(calls)) {
          // Span events carry exception messages and stacks; Axiom also keeps status messages.
          expect(JSON.stringify(spans), `${name}: the spans omit the app's text`).not.toContain(
            marker,
          );
          expect(JSON.stringify(spans), `${name}: the spans omit the app's status`).not.toContain(
            String(status),
          );
          expect(logs.join("\n"), `${name}: the logs omit the app's text`).not.toContain(marker);
          if (name === "released") continue;
          // Host spans record the error's name and fixed description, with no stack lines of its
          // own: only the frames Effect appends for the operation's spans follow.
          const [failedCall] = named(
            spans,
            name === "workflowRun" ? "workflow.step" : "sdk.tools.call",
          );
          const event = failedCall?.events.find(({ name }) => name === "exception");
          const description =
            name === "thrown" || name === "rewritten"
              ? "ToolCallFailed: The tool failed: the app's code raised an error"
              : name === "mcp"
                ? "ToolCallFailed: The tool failed: the app's MCP server failed during call (request)"
                : name === "invalid"
                  ? "InputInvalid: The tool's input did not match its schema; the problems are not recorded"
                  : name === "workflowRun"
                    ? "WorkflowFailure: The workflow failed (execution); the app's error is not recorded"
                    : "AppEvaluationFailed: Tools could not be loaded: the app's definition could not be evaluated";
          expect(
            `${event?.attributes["exception.type"]}: ${event?.attributes["exception.message"]}`,
          ).toBe(description);
          const [first, ...frames] = event?.attributes["exception.stacktrace"]?.split("\n") ?? [];
          expect(first, `${name}: the stack starts with the recorded description`).toBe(
            description,
          );
          for (const frame of frames)
            expect(frame, `${name}: only span frames follow`).toMatch(
              /^ {4}at .+ \([^()\s]+:\d+:\d+\)$/,
            );
          // Every record forwarded from the app isolate has only the host's vocabulary: its own
          // attributes from closed sets, its owners and timing, and exceptions by kind with fixed
          // text.
          for (const { span } of appSpans(spans)) {
            expect(
              Object.keys(span.tags).filter(
                (key) =>
                  !resource.includes(key) &&
                  ![
                    "executor.clock.type",
                    "executor.trace.parent_sampled",
                    "executor.operation",
                    "executor.outcome",
                    "executor.failure.source",
                    "executor.failure.code",
                    "error.type",
                    "executor.owner",
                    "executor.app.code",
                    "cache.method",
                    "executor.workflow.operation",
                    "executor.upstream.wait_ms",
                    "executor.elicitation.wait_ms",
                    "executor.authored_ms",
                    "executor.overhead_ms",
                  ].includes(key),
              ),
              `${name}: ${span.operationName} records only the host's attributes`,
            ).toEqual([]);
            for (const exception of span.events)
              expect(exception).toEqual(appException(exception.attributes["exception.type"] ?? ""));
          }
        }

        // The app's error: its name and code are not the framework's, so they are unrecognized.
        // The rewritten records keep only what the framework sent, plus the added exception, by
        // kind, and the added span under a fixed name.
        const appCall = (app: string) => ({
          ...resourceTags(app),
          "executor.clock.type": expect.any(String),
          "error.type": "unrecognized",
          "executor.failure.source": "app",
          "executor.failure.code": "unrecognized",
          // How the call's time divided by owner: measured values, kept as numbers.
          "executor.upstream.wait_ms": expect.stringMatching(/^\d+(\.\d+)?$/),
          "executor.elicitation.wait_ms": expect.stringMatching(/^\d+(\.\d+)?$/),
          "executor.authored_ms": expect.stringMatching(/^\d+(\.\d+)?$/),
          "executor.overhead_ms": expect.stringMatching(/^\d+(\.\d+)?$/),
        });
        expect(named(thrown.spans, "app.call")).toMatchObject([
          { tags: appCall(ordinary.id), events: [appException("HostOperationFailed")] },
        ]);
        expect(named(thrown.spans, "app.call")[0]?.tags).toEqual(appCall(ordinary.id));
        expect(named(rewritten.spans, "app.call")[0]?.tags).toEqual(appCall(rewriting.id));
        expect(named(rewritten.spans, "app.call")[0]?.events).toEqual([
          appException("HostOperationFailed"),
          appException("unrecognized"),
        ]);
        for (const { spans } of [thrown, rewritten])
          expect(
            named(spans, "app.dispatch").map(({ tags }) => tags["executor.operation"]),
          ).toEqual(["call"]);
        expect(named(rewritten.spans, "app.unrecognized").map(({ tags }) => tags)).toEqual([
          { ...resourceTags(rewriting.id), "executor.operation": "call" },
        ]);
        expect(named(thrown.spans, "app.unrecognized")).toEqual([]);

        // A failure in the framework's request handler logs the framework's own sentence. A
        // rewritten log keeps its level number but its text, level name and attributes are
        // replaced.
        expect(
          unanswered.appLogs.map(({ severityText, body: text }) => ({ severityText, body: text })),
        ).toEqual([{ severityText: "Error", body: "The app's request failed unexpectedly" }]);
        expect(rewrittenLog.appLogs.map(({ body: text }) => text)).toEqual([
          "Text from the app is not recorded",
        ]);
        for (const { appLogs } of [unanswered, rewrittenLog])
          for (const { attributes } of appLogs)
            expect(Object.keys(attributes).filter((key) => !resource.includes(key))).toEqual([]);

        if (cloud) {
          // Cloud's runner records the kind of each failed call, not its text.
          const classified = (spans: typeof rejected.spans) =>
            spans.find(({ span }) => span.tags["executor.runtime.failure"] !== undefined)?.span
              .tags;
          expect(classified(rejected.spans)).toMatchObject({
            "executor.runtime.failure": "unrecognized",
            "executor.runtime.cause":
              "The app's Worker failed for a reason the runtime did not recognize",
          });
          expect(classified(malformed.spans)).toMatchObject({
            "executor.runtime.failure": "invalid-reply",
            "executor.runtime.cause": "The app's reply does not match its host protocol",
          });
          // The release's rejection is classified like the call's own, by its fixed sentence.
          const [release] = named(released.spans, "runtime.app.rpc.release");
          expect(release?.status).toBe("error");
          expect(release?.tags).toMatchObject({
            "executor.runtime.failure": "unrecognized",
            "executor.runtime.cause":
              "The app's Worker failed for a reason the runtime did not recognize",
          });
          const releaseFailure = release?.events.find(({ name }) => name === "exception");
          expect(
            `${releaseFailure?.attributes["exception.type"]}: ${releaseFailure?.attributes["exception.message"]}`,
          ).toBe(
            "RuntimeProtocolFailed: The app's Worker failed for a reason the runtime did not recognize",
          );
        }
        if (sentry !== undefined) {
          // The failures are still reported, by name with the fixed description and no stack of
          // their own, and the app's text appears nowhere in the envelopes.
          for (const { trace } of [thrown, rewritten])
            expect(
              traceEvents(sentry.events, trace).flatMap(({ exception }) => exception?.values ?? []),
            ).toEqual([
              {
                type: "ToolCallFailed",
                value: "The tool failed: the app's code raised an error",
              },
            ]);
          expect(
            traceEvents(sentry.events, mcp.trace).flatMap(
              ({ exception }) => exception?.values ?? [],
            ),
          ).toEqual([
            {
              type: "ToolCallFailed",
              value: "The tool failed: the app's MCP server failed during call (request)",
            },
          ]);
          const workflowReports = traceEvents(sentry.events, workflowRun?.trace ?? "").flatMap(
            ({ exception }) => exception?.values ?? [],
          );
          expect(workflowReports.length).toBeGreaterThan(0);
          for (const report of workflowReports)
            expect(report).toEqual({
              type: "WorkflowFailure",
              value: "The workflow failed (execution); the app's error is not recorded",
            });
          // Invalid input is the caller's to correct, so it is not reported as an incident.
          expect(traceEvents(sentry.events, invalid.trace)).toEqual([]);
          expect(sentry.raw, "incident reports omit the app's text").not.toContain(marker);
          expect(sentry.raw, "incident reports omit the app's status").not.toContain(
            String(status),
          );
        }
      }),
    ),
  );
});
