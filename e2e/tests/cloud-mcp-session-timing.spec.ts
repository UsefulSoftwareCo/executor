/**
 * A session object's clock only advances on I/O, so its own spans cannot show its CPU or time a
 * request waits behind other work on its isolate. Each forward therefore records the gateway's
 * wait and the duration the object observed, each on its own clock, and their difference only
 * when the clocks agree. Each object request records how many other requests its object and every
 * session object in its isolate were answering when it started.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomBytes, randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, type SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { appsManifest } from "../support/apps-release.ts";

type Span = (typeof SpanQuery.Type)["data"][number]["span"];

/** How long the delayed tool waits before it answers. */
const delayMs = 3000;

const timingAppSource = `import { defineApp, query, object, string, number, boolean, router } from "apps";
export default defineApp({ accounts: {} }, async () => ({ tools: router({
  echo: query({ input: object({ text: string() }), description: "Echo text" },
    async (_ctx, { text }) => ({ text })),
  wait: query({ input: object({ ms: number() }), output: object({ done: boolean() }), description: "Answer after a delay" },
    async (_ctx, { ms }) => { await new Promise((resolve) => setTimeout(resolve, ms)); return { done: true }; }),
  fail: query({ input: object({}), description: "Always fail" },
    async () => { throw new Error("Deliberate failure"); }),
}) }));`;

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});

/** The object's timing header, which a client must neither see nor set. */
const internal = "x-executor-session-handled-ms";

/** A stateless request names its revision and capabilities in each request. */
const revision = "2026-07-28";
const requestMeta = {
  "io.modelcontextprotocol/protocolVersion": revision,
  "io.modelcontextprotocol/clientCapabilities": {},
};

layer(HostedLive, { excludeTestServices: true })("Cloud MCP session timing", (it) => {
  it.effect(
    scenarios.cloudMcpSessionTiming.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            mcp = yield* McpClient,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry,
            target = yield* Target,
            http = yield* HttpClient.HttpClient;
          const prefix = `/api/organizations/${actors.organization.id}`;
          // Each key is its own grant, so its MCP sessions reach their own session object.
          const createKey = (name: string) =>
            Effect.gen(function* () {
              const key = yield* body(
                Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
                yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", { name }),
              );
              yield* Effect.addFinalizer(() =>
                api
                  .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
                  .pipe(Effect.orDie),
              );
              return key.key;
            });
          const key = yield* createKey("Session timing");
          const otherKey = yield* createKey("Session timing, other object");
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Session timing ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: timingAppSource }, appsManifest],
          });
          expect(deployed.status).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const tool = (name: string) => `tools[${JSON.stringify(app.slug)}].${name}`;

          // Two MCP sessions over one key reach the same session object; the other key's, another.
          const organization = { organization: actors.organization.id };
          const first = yield* mcp.connect(key, "session-timing-first", organization);
          const second = yield* mcp.connect(key, "session-timing-second", organization);
          const other = yield* mcp.connect(otherKey, "session-timing-other", organization);
          const call = (client: typeof first, label: string, code: string) =>
            client.use(label, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            );
          const execute = (client: typeof first, label: string, code: string, expected: unknown) =>
            call(client, label, code).pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Completed)(result.structuredContent),
              ),
              Effect.tap((completed) =>
                Effect.sync(() => expect(completed.execution.value).toEqual(expected)),
              ),
            );
          const echo = (client: typeof first, label: string, text: string) =>
            execute(
              client,
              label,
              `return (await ${tool("echo")}({ text: ${JSON.stringify(text)} })).text;`,
              text,
            );
          const wait = (client: typeof first, label: string) =>
            execute(
              client,
              label,
              `return (await ${tool("wait")}({ ms: ${delayMs} })).done;`,
              true,
            );
          // Load the app's tools and start its Worker, so the timed calls below are warm.
          yield* echo(first, "Warm the session", "warm");
          yield* echo(other, "Warm the other session", "warm");

          /** One raw request to /mcp under its own trace, for requests the MCP SDK cannot shape. */
          const raw = (
            credential: Redacted.Redacted<string>,
            message:
              | { id: number; method: string; params: Readonly<Record<string, unknown>> }
              | string,
            headers: Readonly<Record<string, string>> = {},
            traceId = randomBytes(16).toString("hex"),
          ) =>
            Effect.gen(function* () {
              const request = HttpClientRequest.post(`${target.metadata.origin}/mcp`).pipe(
                HttpClientRequest.bearerToken(Redacted.value(credential)),
                HttpClientRequest.setHeaders({
                  accept: "application/json, text/event-stream",
                  "content-type": "application/json",
                  "mcp-protocol-version": revision,
                  "x-executor-organization": actors.organization.id,
                  traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
                  // Stateless requests repeat their method and name for routing.
                  ...(typeof message === "string"
                    ? {}
                    : {
                        "mcp-method": message.method,
                        ...(typeof message.params.name === "string"
                          ? { "mcp-name": message.params.name }
                          : {}),
                      }),
                  ...headers,
                }),
              );
              const response = yield* http.execute(
                typeof message === "string"
                  ? HttpClientRequest.bodyText(request, message, "application/json")
                  : yield* HttpClientRequest.bodyJson(request, { jsonrpc: "2.0", ...message }),
              );
              return { traceId, response };
            }).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
          const toolCall = (code: string) => ({
            id: 1,
            method: "tools/call",
            params: { name: "execute", arguments: { code }, _meta: requestMeta },
          });
          const exposed = (headers: Readonly<Record<string, string>>) =>
            Object.keys(headers).filter((name) => name.toLowerCase() === internal);

          // The gateway's forward and the object's request of one MCP request.
          const forwarded = (traces: ReadonlyArray<string>, method: string) =>
            Effect.forEach(traces, (trace) =>
              telemetry.query(trace).pipe(Effect.map((result) => ({ trace, result }))),
            ).pipe(
              Effect.map((results) =>
                results.flatMap(({ trace, result }) => {
                  const spans = result.data.map(({ span }) => span);
                  const forward = spans.find(
                    (span) => span.operationName === "mcp.session.forward",
                  );
                  const request = spans.find(
                    (span) => span.operationName === "mcp.session.request",
                  );
                  const matches = spans.some((span) => span.operationName.endsWith(`/${method}`));
                  return forward === undefined || request === undefined || !matches
                    ? []
                    : [{ trace, forward, request }];
                }),
              ),
            );
          // Traces are read again on each attempt: a request is recorded when its response arrives.
          const located = (
            traces: Effect.Effect<ReadonlyArray<string>>,
            count: number,
            method = "tools/call",
            attempts = 40,
          ) =>
            traces.pipe(
              Effect.flatMap((traces) => forwarded(traces, method)),
              Effect.flatMap((found) =>
                found.length < count
                  ? Effect.fail(new Error("The requests' spans have not reached Motel"))
                  : Effect.succeed(found),
              ),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: attempts }),
            );
          const found = (
            traces: Effect.Effect<ReadonlyArray<string>>,
            count: number,
            method = "tools/call",
          ) => located(traces, count, method).pipe(Effect.map((found) => found.map(timing)));
          const since = (before: number) =>
            evidence.requests.pipe(
              Effect.map((requests) => requests.slice(before).map((request) => request.traceId)),
            );
          const tag = (span: Span, name: string) => {
            const value = span.tags[name];
            if (value === undefined) throw new Error(`${span.operationName} has no ${name}`);
            return value;
          };
          const timing = ({ forward, request }: { forward: Span; request: Span }) => {
            const unseen = forward.tags["executor.mcp.session.unseen_ms"];
            return {
              waitedMs: Number(tag(forward, "executor.mcp.session.waited_ms")),
              handledMs: Number(tag(forward, "executor.mcp.session.handled_ms")),
              unseenMs: unseen === undefined ? undefined : Number(unseen),
              clocksDisagree: tag(forward, "executor.mcp.session.clocks_disagree") === "true",
              forwardMs: forward.durationMs,
              requestMs: request.durationMs,
              status: request.tags["http.response.status_code"],
              objectId: tag(request, "executor.mcp.object_id"),
              object: Number(tag(request, "executor.mcp.concurrent.object")),
              isolate: Number(tag(request, "executor.mcp.concurrent.isolate")),
            };
          };
          type Timing = ReturnType<typeof timing>;
          // Each duration sits inside the span on its own clock, and the residual is their difference.
          const accounted = (call: Timing | undefined) => {
            expect(call, "The request was traced").toBeDefined();
            if (call === undefined) return;
            expect(call.waitedMs, "The gateway's wait is inside its forward").toBeLessThanOrEqual(
              call.forwardMs,
            );
            expect(
              call.handledMs,
              "The object's observed time is inside its request",
            ).toBeLessThanOrEqual(call.requestMs);
            expect(call.isolate, "The isolate holds the object's requests").toBeGreaterThanOrEqual(
              call.object,
            );
            expect(
              call.clocksDisagree,
              "The clocks disagree exactly when the object observed more than the gateway waited",
            ).toBe(call.handledMs > call.waitedMs);
            expect(
              call.unseenMs !== undefined,
              "A residual is recorded exactly when the clocks agree",
            ).toBe(!call.clocksDisagree);
            if (call.clocksDisagree)
              expect(call.unseenMs, "Disagreeing clocks record no residual").toBeUndefined();
            else
              expect(call.unseenMs, "The residual is the wait the object did not observe").toBe(
                call.waitedMs - call.handledMs,
              );
            expect(call.unseenMs ?? 0, "No residual is negative").toBeGreaterThanOrEqual(0);
          };

          // A call alone on its object.
          const beforeAlone = (yield* evidence.requests).length;
          yield* echo(first, "Call alone", "alone");
          const [aloneCall] = yield* located(since(beforeAlone), 1);
          const alone = aloneCall === undefined ? undefined : timing(aloneCall);
          yield* evidence.json("alone.json", alone);
          accounted(alone);
          expect(alone?.object, "Nothing else was being answered on the object").toBe(0);

          // The call's spans name its organization by opaque ID, so their latency can be split by
          // organization. Each authentication says whether it opened a database connection; the
          // gateway's Worker event opens its own.
          const attributed = yield* telemetry.query(aloneCall?.trace ?? "").pipe(
            Effect.map((result) => result.data.map(({ span }) => span)),
            Effect.flatMap((spans) =>
              spans.some((span) => span.operationName === "mcp.tool.call")
                ? Effect.succeed(spans)
                : Effect.fail(new Error("The call's tool span has not reached Motel")),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
          );
          const spansNamed = (name: string) =>
            attributed.filter((span) => span.operationName === name);
          for (const name of [
            "mcp.session.forward",
            "mcp.session.request",
            "mcp.tool.call",
            "auth.authenticate",
          ]) {
            const spans = spansNamed(name);
            expect(spans.length, `The call recorded ${name}`).toBeGreaterThan(0);
            expect(
              spans.map((span) => span.tags["executor.organization.id"]),
              `${name} names the call's organization`,
            ).toEqual(spans.map(() => actors.organization.id));
          }
          const authentications = spansNamed("auth.authenticate");
          expect(
            authentications.map((span) => span.tags["db.connect.opened"]),
            "Each authentication says whether it opened a connection",
          ).toEqual(authentications.map(() => expect.stringMatching(/^(true|false)$/)));
          const gateway = spansNamed("mcp.session.forward")[0];
          expect(
            authentications
              .filter((span) => span.parentSpanId === gateway?.parentSpanId)
              .map((span) => span.tags["db.connect.opened"]),
            "The gateway's event opens a connection to authenticate",
          ).toEqual(["true"]);
          // The call's tool rechecks its grant on the session object, which the warm-up above and
          // this call's own request have already connected. Nothing else runs on the object, so
          // no other call's connection is counted either.
          const toolSpan = spansNamed("mcp.tool.call")[0];
          expect(
            authentications
              .filter((span) => span.parentSpanId === toolSpan?.spanId)
              .map((span) => span.tags["db.connect.opened"]),
            "The warm session's recheck opens no connection",
          ).toEqual(["false"]);

          // A call waiting on its app holds a request open on its object. Another call on the same
          // object starts during it, and then a call on another object. Local Cloud runs every
          // session object in one isolate; on Workers they spread across isolates and machines.
          const beforeOverlap = (yield* evidence.requests).length;
          yield* Effect.all(
            [
              wait(first, "Call that waits"),
              Effect.sleep("1 second").pipe(
                Effect.andThen(echo(second, "Call on the same object while another waits", "same")),
              ),
              Effect.sleep("2 seconds").pipe(
                Effect.andThen(echo(other, "Call on another object while another waits", "other")),
              ),
            ],
            { concurrency: 3 },
          );
          const overlapping = yield* found(since(beforeOverlap), 3);
          yield* evidence.json("overlapping.json", overlapping);
          for (const call of overlapping) accounted(call);
          const waiting = overlapping.find((call) => call.waitedMs >= delayMs);
          expect(waiting, "The delayed call's wait covers its delay").toBeDefined();
          expect(waiting?.handledMs, "The object observed the delay").toBeGreaterThanOrEqual(
            delayMs,
          );
          expect(waiting?.object, "The delayed call started first").toBe(0);
          const sameObject = overlapping.find(
            (call) => call !== waiting && call.objectId === waiting?.objectId,
          );
          const otherObject = overlapping.find((call) => call.objectId !== waiting?.objectId);
          expect(sameObject?.object, "The same object was answering the delayed call").toBe(1);
          expect(sameObject?.isolate ?? 0).toBeGreaterThanOrEqual(1);
          expect(otherObject, "The other key reached another object").toBeDefined();
          expect(otherObject?.object, "The other object had nothing else to answer").toBe(0);
          expect(
            otherObject?.isolate,
            "The isolate was answering the first object's delayed call",
          ).toBeGreaterThanOrEqual(1);

          // Requests that fail, are malformed, are cancelled or are abandoned each end their count.
          const traced = (trace: string) =>
            telemetry.query(trace).pipe(
              Effect.map((result) =>
                result.data
                  .map(({ span }) => span)
                  .filter((span) => span.operationName.startsWith("mcp.session."))
                  .map((span) => ({
                    name: span.operationName,
                    durationMs: span.durationMs,
                    status: span.status,
                    tags: Object.fromEntries(
                      Object.entries(span.tags).filter(([name]) =>
                        /^executor\.mcp\.(session|concurrent)\.|^http\.response/.test(name),
                      ),
                    ),
                  })),
              ),
            );
          const beforeFailed = (yield* evidence.requests).length;
          yield* call(first, "A tool that fails", `return await ${tool("fail")}({});`);
          const [failed] = yield* found(since(beforeFailed), 1);
          const malformed = yield* Effect.scoped(
            raw(key, "{ not json").pipe(
              Effect.flatMap(({ traceId, response }) =>
                response.text.pipe(Effect.map((text) => ({ traceId, text }))),
              ),
            ),
          );
          expect(malformed.text, "The object rejects a malformed request").toContain(
            '"Parse error"',
          );
          // An MCP client cancels its call, which interrupts the call on the object.
          const beforeCancelled = (yield* evidence.requests).length;
          const cancelled = yield* wait(first, "A call the client cancels").pipe(
            Effect.timeout("500 millis"),
            Effect.option,
          );
          expect(cancelled._tag, "The client cancelled the delayed call").toBe("None");
          // Each request is recorded when its answer arrives: the call's once the object has ended
          // it, and the cancellation's.
          const cancelledTraces = yield* since(beforeCancelled).pipe(
            Effect.flatMap((traces) =>
              traces.length < 2
                ? Effect.fail(new Error("The cancelled call has not been answered"))
                : Effect.succeed(traces),
            ),
            Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
          );
          // A client that disconnects leaves the call running on the object until it answers.
          const abandoned = randomBytes(16).toString("hex");
          const disconnected = yield* Effect.scoped(
            raw(
              key,
              toolCall(`return (await ${tool("wait")}({ ms: ${delayMs} })).done;`),
              {},
              abandoned,
            ).pipe(
              Effect.flatMap(({ response }) => response.text),
              Effect.timeout("500 millis"),
              Effect.option,
            ),
          );
          expect(disconnected._tag, "The client disconnected from the delayed call").toBe("None");
          // The object's request span ends after the request leaves both counts.
          yield* telemetry.query(abandoned).pipe(
            Effect.flatMap((result) =>
              result.data.some(({ span }) => span.operationName === "mcp.session.request")
                ? Effect.void
                : Effect.fail(new Error("The abandoned call's object span has not reached Motel")),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
          );
          const beforeAfter = (yield* evidence.requests).length;
          yield* echo(first, "Call after those requests", "after");
          const [after] = yield* found(since(beforeAfter), 1);
          // A span leaves its isolate with the first flush after it ends, which may be a later
          // request's (packages/telemetry/src/isolate.ts). The cancelled call's spans are read
          // once the requests above have flushed both isolates.
          const [interrupted] = yield* located(Effect.succeed(cancelledTraces), 1);
          // MCP withholds a cancelled request's response, so the object ends its POST with an empty
          // stream when the cancellation arrives, and records the time it observed until then.
          const cancelledCall = interrupted === undefined ? undefined : timing(interrupted);
          accounted(cancelledCall);
          expect(cancelledCall?.status, "The object answers the cancelled call's POST").toBe("200");
          expect(
            cancelledCall?.handledMs,
            "The object answered at the cancellation, not when the tool finished",
          ).toBeLessThan(delayMs);
          yield* evidence.json("recovered.json", {
            failed,
            after,
            malformed: yield* traced(malformed.traceId),
            cancelled: interrupted === undefined ? [] : yield* traced(interrupted.trace),
            abandoned: yield* traced(abandoned),
          });
          accounted(failed);
          accounted(after);
          expect(after?.object, "Every earlier request on the object ended its count").toBe(0);
          // The isolate's count covers every session object in it. CI runs this scenario alone on
          // its own local Cloud (e2e/ci-selection.ts), so only its own requests can be counted.
          expect(after?.isolate, "Every earlier request on the isolate ended its count").toBe(0);

          // An open stream counts only until its response is ready.
          const stream = yield* Effect.scoped(
            Effect.gen(function* () {
              const listen = yield* raw(key, {
                id: 1,
                method: "subscriptions/listen",
                params: { _meta: requestMeta, notifications: { toolsListChanged: true } },
              });
              expect(listen.response.status).toBe(200);
              expect(listen.response.headers["content-type"]).toContain("text/event-stream");
              expect(
                exposed(listen.response.headers),
                "A stream carries no internal header",
              ).toEqual([]);
              const beforeQuiet = (yield* evidence.requests).length;
              yield* echo(first, "Call while a stream is open", "streaming");
              const [quiet] = yield* found(since(beforeQuiet), 1);
              return { traceId: listen.traceId, quiet };
            }),
          );
          // A client cannot set the object's timing, and never sees it.
          const spoofed = yield* Effect.scoped(
            raw(key, toolCall(`return (await ${tool("echo")}({ text: "spoofed" })).text;`), {
              [internal]: "987654",
            }).pipe(
              Effect.tap(({ response }) => response.text),
              Effect.map(({ traceId, response }) => ({
                traceId,
                status: response.status,
                exposed: exposed(response.headers),
              })),
            ),
          );
          expect(spoofed.status).toBe(200);
          expect(spoofed.exposed, "The response carries no internal header").toEqual([]);
          const [trusted] = yield* found(Effect.succeed([spoofed.traceId]), 1);
          yield* evidence.json("spoofed.json", trusted);
          accounted(trusted);
          expect(trusted?.handledMs, "The object's own time is recorded").not.toBe(987654);
          // The gateway's spans export once it notices the client left, at the stream's next
          // heartbeat write. The object's request is not needed: its count is checked above.
          const listened = yield* telemetry.query(stream.traceId).pipe(
            Effect.map((result) =>
              result.data
                .map(({ span }) => span)
                .find((span) => span.operationName === "mcp.session.forward"),
            ),
            Effect.flatMap((span) =>
              span === undefined
                ? Effect.fail(new Error("The stream's forward has not reached Motel"))
                : Effect.succeed(span),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
            Effect.map((forward) => {
              const unseen = forward.tags["executor.mcp.session.unseen_ms"];
              return {
                waitedMs: Number(tag(forward, "executor.mcp.session.waited_ms")),
                handledMs: Number(tag(forward, "executor.mcp.session.handled_ms")),
                unseenMs: unseen === undefined ? undefined : Number(unseen),
                clocksDisagree: tag(forward, "executor.mcp.session.clocks_disagree") === "true",
                forwardMs: forward.durationMs,
              };
            }),
          );
          yield* evidence.json("stream.json", { listened, quiet: stream.quiet });
          accounted(stream.quiet);
          expect(stream.quiet?.object, "The open stream no longer counts").toBe(0);
          expect(listened.waitedMs, "The gateway's wait is inside its forward").toBeLessThanOrEqual(
            listened.forwardMs,
          );
          expect(listened.clocksDisagree).toBe(listened.handledMs > listened.waitedMs);
          expect(listened.unseenMs !== undefined).toBe(!listened.clocksDisagree);
          if (listened.clocksDisagree) expect(listened.unseenMs).toBeUndefined();
          else expect(listened.unseenMs).toBe(listened.waitedMs - listened.handledMs);
          expect(
            listened.waitedMs,
            "The stream stayed open through the quiet call, which its wait ends before",
          ).toBeLessThan(stream.quiet?.requestMs ?? 0);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 120_000 },
  );
});
