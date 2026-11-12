/**
 * A Cloud MCP session outlives its session object's memory. The object keeps each session's
 * negotiated `initialize` in its storage, so after an eviction (or a deploy's restart)
 * the client continues with the same `Mcp-Session-Id` instead of getting 404 and initializing
 * again. These cases hold what a restored session is and is not: it keeps its negotiated
 * version, the log level the client set and its elicitation mode, it is read only after the
 * bearer is verified and names the object, and a session the object never stored is still not
 * found. An object keeps its 64 most recently used sessions; concurrent first requests after a
 * wake restore sessions while another opens and prunes, and every answer agrees with the store.
 * A program waiting for approval through that idle wait keeps its own object in memory, so the
 * person's answer still continues it (FB-069: idle eviction lost it and resume said not-found).
 * After a restart, a resume of an answered request says what the object recorded: `answered`
 * when it stored the answer, and, when that write failed (the local hook in
 * `mcp-interaction-faults-local.ts`), `lost` copy that does not claim the request went unanswered.
 *
 * Not covered here: the 7-day expiry (managed Cloud has no clock control) and a failing session
 * storage call (no public surface can cause one; the hook refuses only request-record writes).
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Duration, Effect, FileSystem, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, type SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

type Span = (typeof SpanQuery.Type)["data"][number]["span"];

const Token = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
/** A stateful revision every elicitation mode serves. */
const stateful = "2025-06-18";
const signedId =
  /^([0-9a-f]{64})\.([A-Za-z0-9_-]{43})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const sessionNotFound = "Session not found";
const native = "?elicitation_mode=native";
/**
 * workerd evicts an object some time after its last request once nothing holds it (Cloudflare:
 * 70–140 s). The session's database window holds it for 120 s after its last call. The step after
 * the wait checks that the object did restart.
 */
const idle = Duration.seconds(270);
/** An app whose one tool always asks for approval. */
const reviewSource = `import { defineApp, mutation, object, string, router } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, async () => ({ tools: router({
  review: mutation({ input: object({ note: string() }), approval: always(), description: "Record a reviewed note" },
    async (_ctx, { note }) => ({ reviewed: note })),
}) }));`;
const Paused = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({
      status: Schema.Literal("approval-required"),
      requestId: Schema.String,
      expiresAt: Schema.Number,
    }),
  }),
});
const Unavailable = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({
      status: Schema.Literal("unavailable"),
      reason: Schema.String,
      message: Schema.String,
    }),
  }),
});
const Resumed = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({
      status: Schema.Literal("completed"),
      execution: Schema.Struct({ ok: Schema.Boolean, value: Schema.Unknown }),
    }),
  }),
});
/** Sessions an object keeps (`mcp-session-store.ts`). */
const kept = 64;

/** The key Alchemy minted for one logical id, read from this local Cloud's state. */
const RandomState = Schema.Struct({
  attr: Schema.Struct({ text: Schema.Struct({ __redacted__: Schema.String }) }),
});
const mac = (key: string, objectId: string, sessionId: string) =>
  createHmac("sha256", Buffer.from(key, "hex"))
    .update(`executor mcp session\n${objectId}\n${sessionId}`)
    .digest("base64url");

layer(HostedLive, { excludeTestServices: true })("Cloud MCP session restore", (it) => {
  it.effect(
    scenarios.cloudMcpSessionRestore.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry,
            target = yield* Target,
            fs = yield* FileSystem.FileSystem,
            http = yield* HttpClient.HttpClient;
          const organization = actors.organization.id;

          const createKey = (actor: typeof actors.owner, name: string) =>
            Effect.gen(function* () {
              const created = yield* api.request(actor, "POST", "/api/auth/api-key/create", {
                name,
              });
              expect(created.status).toBe(200);
              const key = yield* body(Token, created);
              yield* Effect.addFinalizer(() =>
                api
                  .request(actor, "POST", "/api/auth/api-key/delete", { keyId: key.id })
                  .pipe(Effect.ignore),
              );
              return key;
            });

          /** One MCP POST under its own trace; the answer is JSON or one SSE message. */
          const post = (input: {
            readonly credential: Redacted.Redacted<string>;
            readonly session?: string | undefined;
            readonly protocol?: string | undefined;
            readonly query?: string | undefined;
            /** Refuse the session object's request-record writes while this request runs. */
            readonly refuseRecords?: boolean;
            readonly message: Readonly<Record<string, unknown>>;
          }) =>
            Effect.scoped(
              Effect.gen(function* () {
                const traceId = randomBytes(16).toString("hex");
                const request = HttpClientRequest.post(
                  `${target.metadata.origin}/mcp${input.query ?? ""}`,
                ).pipe(
                  HttpClientRequest.setHeaders({
                    accept: "application/json, text/event-stream",
                    "x-executor-organization": organization,
                    traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
                    authorization: `Bearer ${Redacted.value(input.credential)}`,
                    ...(input.session === undefined ? {} : { "mcp-session-id": input.session }),
                    ...(input.protocol === undefined
                      ? {}
                      : { "mcp-protocol-version": input.protocol }),
                    ...(input.refuseRecords === true
                      ? { "x-executor-test-fault": "interaction-writes" }
                      : {}),
                  }),
                );
                const response = yield* http.execute(
                  yield* HttpClientRequest.bodyJson(request, { jsonrpc: "2.0", ...input.message }),
                );
                const text = yield* response.text;
                const data = text
                  .split("\n")
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice("data:".length).trim())
                  .at(-1);
                return {
                  traceId,
                  status: response.status,
                  headers: response.headers,
                  text: data ?? text,
                };
              }),
            ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));

          const open = (credential: Redacted.Redacted<string>, label: string, query = "") =>
            Effect.gen(function* () {
              const answer = yield* post({
                credential,
                query,
                message: {
                  id: 1,
                  method: "initialize",
                  params: {
                    protocolVersion: stateful,
                    capabilities: { elicitation: {} },
                    clientInfo: { name: `restore-${label}`, version: "1" },
                  },
                },
              });
              expect(answer.status, answer.text).toBe(200);
              const session = answer.headers["mcp-session-id"] ?? "";
              expect(session, "The object issues a signed session id").toMatch(signedId);
              const initialized = yield* post({
                credential,
                session,
                query,
                protocol: stateful,
                message: { method: "notifications/initialized" },
              });
              expect(initialized.status).toBe(202);
              return session;
            });
          const initialize = (credential: Redacted.Redacted<string>, label: string, query = "") =>
            evidence.step(`Initialize a session (${label})`, open(credential, label, query));
          const listTools = (
            credential: Redacted.Redacted<string>,
            session: string,
            options: { readonly query?: string; readonly protocol?: string | undefined } = {},
          ) =>
            post({
              credential,
              session,
              query: options.query,
              protocol: "protocol" in options ? options.protocol : stateful,
              message: { id: 2, method: "tools/list", params: {} },
            });
          const listsTools = (answer: { status: number; text: string }) => {
            expect(answer.status, answer.text).toBe(200);
            expect(answer.text).toContain('"execute"');
          };
          const notFound = (answer: { status: number; text: string }) => {
            expect(answer.status, answer.text).toBe(404);
            expect(answer.text).toContain(sessionNotFound);
          };

          /** The object's spans of one finished request, once its request span has arrived. */
          const objectSpans = (traceId: string) =>
            telemetry.query(traceId).pipe(
              Effect.map((result) => result.data.map(({ span }) => span)),
              Effect.flatMap((all) =>
                all.some(
                  (span) =>
                    span.operationName === "mcp.session.request" &&
                    span.tags["http.response.status_code"] !== undefined,
                )
                  ? Effect.succeed(all)
                  : Effect.fail(new Error("The request's spans have not reached Motel")),
              ),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
              Effect.tap((all) => evidence.json(`trace-${traceId}.json`, all)),
            );
          const activation = (spans: ReadonlyArray<Span>) =>
            spans.find((span) => span.operationName === "mcp.session.request")?.tags[
              "executor.mcp.activation_id"
            ];
          const restores = (spans: ReadonlyArray<Span>) =>
            spans
              .filter((span) => span.operationName === "mcp.session.restore")
              .map((span) => span.tags["executor.mcp.session.restore"]);
          const restoredLevels = (spans: ReadonlyArray<Span>) =>
            spans
              .filter((span) => span.operationName === "mcp.session.restore")
              .map((span) => span.tags["executor.mcp.session.log_level"]);

          const state = yield* fs
            .readFileString(`${target.directory}/alchemy-state.json`)
            .pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.fromJsonString(Schema.Struct({ directory: Schema.String })),
                ),
              ),
            );
          const currentKey = fs.readFileString(`${state.directory}/McpSessionKeyA.json`).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RandomState))),
            Effect.map((resource) => resource.attr.text.__redacted__),
          );

          const owner = yield* createKey(actors.owner, "Session restore owner");
          const member = yield* createKey(actors.member, "Session restore member");
          const crowded = yield* createKey(actors.owner, "Session restore crowded");
          const parked = yield* createKey(actors.owner, "Session restore parked");
          const answering = yield* createKey(actors.owner, "Session restore answered");
          const session = yield* initialize(owner.key, "owner");
          const nativeSession = yield* initialize(owner.key, "owner-native", native);
          const before = yield* evidence.step(
            "Both sessions answer from the object's memory, which reads no stored session",
            Effect.gen(function* () {
              const answer = yield* listTools(owner.key, session);
              listsTools(answer);
              listsTools(yield* listTools(owner.key, nativeSession, { query: native }));
              const spans = yield* objectSpans(answer.traceId);
              expect(restores(spans), "A session in memory is not read from storage").toEqual([]);
              return activation(spans);
            }),
          );

          yield* evidence.step(
            "The client sets the session's log level, which the object stores",
            Effect.gen(function* () {
              const answer = yield* post({
                credential: owner.key,
                session,
                protocol: stateful,
                message: { id: 3, method: "logging/setLevel", params: { level: "warning" } },
              });
              expect(answer.status, answer.text).toBe(200);
              expect(answer.text).toContain('"result"');
            }),
          );

          // Another object (its own API key) opens one session more than it keeps, one at a time,
          // so each is used later than the one before. The first is the least recently used.
          const crowd = yield* evidence.step(
            `Another object opens ${kept + 1} sessions, one more than it keeps`,
            Effect.forEach(
              Array.from({ length: kept + 1 }, (_, index) => index),
              (index) =>
                open(crowded.key, `crowd-${index}`).pipe(
                  Effect.tap(() => Effect.sleep("5 millis")),
                ),
            ),
          );

          const prefix = `/api/organizations/${organization}`;
          const app = yield* evidence.step(
            "Deploy an app whose tool always asks for approval",
            Effect.gen(function* () {
              const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
                name: `Parked review ${randomUUID().slice(0, 8)}`,
                files: [{ path: "index.ts", content: reviewSource }, appsManifest],
              });
              expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
              const deployedApp = yield* body(App, deployed);
              yield* Effect.addFinalizer(() =>
                api
                  .request(actors.owner, "DELETE", `${prefix}/apps/${deployedApp.id}`)
                  .pipe(Effect.ignore),
              );
              return deployedApp;
            }),
          );
          /** Calls the review tool, which pauses for approval. */
          const pause = (credential: Redacted.Redacted<string>, mcpSession: string, note: string) =>
            Effect.gen(function* () {
              const answer = yield* post({
                credential,
                session: mcpSession,
                protocol: stateful,
                message: {
                  id: 4,
                  method: "tools/call",
                  params: {
                    name: "call",
                    arguments: {
                      calls: {
                        path: `tools[${JSON.stringify(app.slug)}].review`,
                        input: { note },
                      },
                    },
                  },
                },
              });
              expect(answer.status, answer.text).toBe(200);
              const paused = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Paused))(
                answer.text,
              );
              return {
                requestId: paused.result.structuredContent.requestId,
                activation: activation(yield* objectSpans(answer.traceId)),
              };
            });
          const approve = (
            credential: Redacted.Redacted<string>,
            mcpSession: string,
            requestId: string,
            refuseRecords = false,
          ) =>
            post({
              credential,
              session: mcpSession,
              protocol: stateful,
              refuseRecords,
              message: {
                id: 5,
                method: "tools/call",
                params: {
                  name: "resume",
                  arguments: { requestId, response: { action: "accept" } },
                },
              },
            });
          const reviewed = (answer: { status: number; text: string }, note: string) =>
            Effect.gen(function* () {
              expect(answer.status, answer.text).toBe(200);
              const resumed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Resumed))(
                answer.text,
              );
              expect(resumed.result.structuredContent.execution).toMatchObject({
                ok: true,
                value: { ok: true, value: { reviewed: note } },
              });
            });

          // A third object, of its own API key, holds a program that waits for approval.
          const review = yield* evidence.step(
            "Another object pauses a call for approval",
            Effect.gen(function* () {
              const parkedSession = yield* open(parked.key, "parked");
              return {
                session: parkedSession,
                ...(yield* pause(parked.key, parkedSession, "parked")),
              };
            }),
          );

          // A fourth object answers two requests. Its write of the first answer is refused, as a
          // failing storage call would, so after the restart its record holds only the issue.
          const answered = yield* evidence.step(
            "Another object answers two requests, the first while it cannot write its record of the answer",
            Effect.gen(function* () {
              const answeredSession = yield* open(answering.key, "answered");
              const unrecorded = yield* pause(answering.key, answeredSession, "unrecorded");
              yield* reviewed(
                yield* approve(answering.key, answeredSession, unrecorded.requestId, true),
                "unrecorded",
              );
              const recorded = yield* pause(answering.key, answeredSession, "recorded");
              yield* reviewed(
                yield* approve(answering.key, answeredSession, recorded.requestId),
                "recorded",
              );
              return {
                session: answeredSession,
                unrecorded: unrecorded.requestId,
                recorded: recorded.requestId,
                activation: recorded.activation,
              };
            }),
          );

          yield* evidence.step(
            "Leave every session idle until workerd evicts the objects and their memory",
            Effect.sleep(idle),
          );

          yield* evidence.step(
            "The paused call's object stayed in memory through the wait, so approving it runs the call",
            Effect.gen(function* () {
              const answer = yield* approve(parked.key, review.session, review.requestId);
              yield* reviewed(answer, "parked");
              expect(
                activation(yield* objectSpans(answer.traceId)),
                "The object that held the program did not restart",
              ).toBe(review.activation);
            }),
          );

          yield* evidence.step(
            "After its object restarted, a recorded answer reads answered, and an answer whose record failed reads lost without claiming the request went unanswered",
            Effect.gen(function* () {
              const unavailable = (requestId: string) =>
                Effect.gen(function* () {
                  const answer = yield* approve(answering.key, answered.session, requestId);
                  expect(answer.status, answer.text).toBe(200);
                  const result = yield* Schema.decodeUnknownEffect(
                    Schema.fromJsonString(Unavailable),
                  )(answer.text);
                  return { ...result.result.structuredContent, traceId: answer.traceId };
                });
              const recorded = yield* unavailable(answered.recorded);
              expect(recorded.reason, recorded.message).toBe("answered");
              expect(
                activation(yield* objectSpans(recorded.traceId)),
                "The object restarted, so only its storage knows the requests",
              ).not.toBe(answered.activation);
              const unrecorded = yield* unavailable(answered.unrecorded);
              expect(unrecorded.reason, unrecorded.message).toBe("lost");
              expect(unrecorded.message).toContain(
                "no retained record of an answer or of how it ended",
              );
              expect(unrecorded.message).toContain("the request may have been answered");
              expect(unrecorded.message).not.toMatch(
                /had not expired or been answered|expired before it was answered/u,
              );
            }),
          );

          yield* evidence.step(
            "Another user's bearer with the session's id is refused before the object reads its storage",
            Effect.gen(function* () {
              const answer = yield* listTools(member.key, session);
              notFound(answer);
              const spans = yield* objectSpans(answer.traceId);
              expect(restores(spans), "No stored session is read for a refused bearer").toEqual([]);
            }),
          );

          yield* evidence.step(
            "Concurrent first requests after the wake continue the session with the same id, restored from storage with its log level",
            Effect.gen(function* () {
              const answers = yield* Effect.all(
                Array.from({ length: 4 }, () => listTools(owner.key, session)),
                { concurrency: "unbounded" },
              );
              const traces = yield* Effect.forEach(answers, (answer) => {
                listsTools(answer);
                return objectSpans(answer.traceId);
              });
              const activations = new Set(traces.map(activation));
              expect(activations.size, "One activation answers every request").toBe(1);
              expect(activations.has(before), "The object restarted").toBe(false);
              const outcomes = traces.flatMap(restores);
              expect(outcomes.length, "At least one request restored the session").toBeGreaterThan(
                0,
              );
              expect(new Set(outcomes)).toEqual(new Set(["restored"]));
              expect(new Set(traces.flatMap(restoredLevels))).toEqual(new Set(["warning"]));
              const again = yield* listTools(owner.key, session);
              listsTools(again);
              expect(
                restores(yield* objectSpans(again.traceId)),
                "The next request finds it in memory",
              ).toEqual([]);
            }),
          );

          yield* evidence.step(
            "The restored session keeps the version it negotiated",
            Effect.gen(function* () {
              listsTools(yield* listTools(owner.key, session, { protocol: undefined }));
              const other = yield* listTools(owner.key, session, { protocol: "2025-11-25" });
              expect(other.status, other.text).toBe(400);
              expect(other.text).toContain(stateful);
            }),
          );

          yield* evidence.step(
            "A session belongs to its elicitation mode after a restore too",
            Effect.gen(function* () {
              notFound(yield* listTools(owner.key, nativeSession));
              listsTools(yield* listTools(owner.key, nativeSession, { query: native }));
            }),
          );

          yield* evidence.step(
            "Concurrent first requests to a full object restore its sessions while another opens, and only the least recently used are forgotten",
            Effect.gen(function* () {
              // While these restore (each one a use), the new session pushes one more out: the
              // least recently used session no request here touches, crowd[1].
              const restoring = crowd.slice(2, 10);
              const { opened, restored } = yield* Effect.all(
                {
                  restored: Effect.forEach(restoring, (id) => listTools(crowded.key, id), {
                    concurrency: "unbounded",
                  }),
                  opened: open(crowded.key, "crowd-new"),
                },
                { concurrency: "unbounded" },
              );
              for (const answer of restored) {
                listsTools(answer);
                expect(restores(yield* objectSpans(answer.traceId))).toEqual(["restored"]);
              }
              listsTools(yield* listTools(crowded.key, opened));
              for (const id of [crowd[0], crowd[1]]) {
                const answer = yield* listTools(crowded.key, id ?? "");
                notFound(answer);
                expect(
                  restores(yield* objectSpans(answer.traceId)),
                  "A session pushed out of the object's storage is not read back",
                ).toEqual(["missing"]);
              }
              for (const id of [crowd[10], crowd[kept]]) {
                const answer = yield* listTools(crowded.key, id ?? "");
                listsTools(answer);
                expect(restores(yield* objectSpans(answer.traceId))).toEqual(["restored"]);
                expect(restoredLevels(yield* objectSpans(answer.traceId))).toEqual(["default"]);
              }
            }),
          );

          yield* evidence.step(
            "A session the object never stored is still not found, and the client starts a new one",
            Effect.gen(function* () {
              const objectId = signedId.exec(session)?.[1] ?? "";
              const forgotten = randomUUID();
              const answer = yield* listTools(
                owner.key,
                `${objectId}.${mac(yield* currentKey, objectId, forgotten)}.${forgotten}`,
              );
              notFound(answer);
              expect(restores(yield* objectSpans(answer.traceId))).toEqual(["missing"]);
              listsTools(yield* listTools(owner.key, yield* initialize(owner.key, "owner-again")));
            }),
          );
        }),
      ),
    { timeout: 480_000 },
  );
});
