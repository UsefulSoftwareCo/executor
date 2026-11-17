import { randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { reveal } from "../support/failure-text.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const Token = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
const Envelope = Schema.Struct({ result: Schema.Struct({ structuredContent: Schema.Unknown }) });
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.Unknown,
    toolCalls: Schema.Array(Schema.Struct({ outcome: Schema.String })),
  }),
});
const Unavailable = Schema.Struct({
  status: Schema.Literal("unavailable"),
  reason: Schema.String,
  message: Schema.String,
  pending: Schema.Array(Schema.Unknown),
});
const source = `import { defineApp, mutation, object, string, router } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, async () => ({ tools: router({
  review: mutation({ input: object({ note: string() }), approval: always() },
    async (_ctx, { note }) => ({ reviewed: note })),
}) }));`;
const protocol = "2025-06-18";

const fixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    target = yield* Target,
    http = yield* HttpClient.HttpClient,
    evidence = yield* Evidence,
    telemetry = yield* Telemetry;
  const created = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
    name: "Parked program",
  });
  expect(created.status).toBe(200);
  const token = yield* body(Token, created);
  yield* Effect.addFinalizer(() =>
    api
      .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: token.id })
      .pipe(Effect.ignore),
  );
  const prefix = `/api/organizations/${actors.organization.id}/apps`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
    name: `Parked ${randomUUID().slice(0, 8)}`,
    files: [{ path: "index.ts", content: source }, appsManifest],
  });
  expect(deployed.status).toBe(200);
  const app = yield* body(App, deployed);
  yield* Effect.addFinalizer(() =>
    api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.ignore),
  );
  // No SSE GET remains open: only the program, not a client's held request, can keep this entry.
  const post = (message: Readonly<Record<string, unknown>>, session?: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const traceId = randomUUID().replaceAll("-", "");
        const request = HttpClientRequest.post(`${target.metadata.origin}/mcp`).pipe(
          HttpClientRequest.setHeaders({
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${reveal(token.key)}`,
            "x-executor-organization": actors.organization.id,
            traceparent: `00-${traceId}-${randomUUID().replaceAll("-", "").slice(0, 16)}-01`,
            ...(session === undefined
              ? {}
              : { "mcp-session-id": session, "mcp-protocol-version": protocol }),
          }),
        );
        const answer = yield* http.execute(
          yield* HttpClientRequest.bodyJson(request, { jsonrpc: "2.0", ...message }),
        );
        const text = yield* answer.text;
        const data = text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .at(-1);
        expect(answer.status, text).toBe(200);
        return { session: answer.headers["mcp-session-id"], text: data ?? text, traceId };
      }),
    ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
  const opened = yield* post({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: protocol,
      capabilities: {},
      clientInfo: { name: "parked-e2e", version: "1" },
    },
  });
  const session = opened.session;
  expect(session).toBeDefined();
  if (session === undefined) return yield* Effect.die("MCP initialize did not issue a session");
  const tool = (name: string, args: Readonly<Record<string, unknown>>, id = session) =>
    post({ id: 2, method: "tools/call", params: { name, arguments: args } }, id).pipe(
      Effect.flatMap(({ text }) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Envelope))(text),
      ),
      Effect.map(({ result }) => result.structuredContent),
    );
  const pause = (notes: string[]) =>
    tool("call", {
      calls: notes.map((note) => ({
        path: `tools[${JSON.stringify(app.slug)}].review`,
        input: { note },
      })),
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Pending)));
  const resume = (requestId: string) =>
    tool("resume", { requestId, response: { action: "accept" } });
  const idle = evidence.step(
    "Leave the caller idle beyond its 1.5-second entry TTL with no held HTTP request",
    Effect.sleep("3 seconds"),
  );
  const restored = (traceId: string) =>
    telemetry.query(traceId).pipe(
      Effect.flatMap(({ data }) =>
        data.some(
          ({ span }) =>
            span.operationName === "mcp.session.restore" &&
            span.tags["executor.mcp.session.restore"] === "restored",
        )
          ? Effect.void
          : Effect.fail(new Error("The idle entry has not restored its session from storage")),
      ),
      Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 40 }),
    );
  return { evidence, pause, resume, idle, post, session, restored, app };
});

layer(HostedLive, { excludeTestServices: true })("Self-host parked MCP programs", (it) => {
  it.effect(scenarios.selfHostMcpParkedBatch.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { evidence, pause, resume, idle, post, session, restored, app } = yield* fixture;
        const first = yield* evidence.step(
          "Pause three gated calls in one batch",
          pause(["one", "two", "three"]),
        );
        yield* idle;
        const second = yield* Schema.decodeUnknownEffect(Pending)(yield* resume(first.requestId));
        expect(second.requestId).not.toBe(first.requestId);
        yield* idle;
        const third = yield* Schema.decodeUnknownEffect(Pending)(yield* resume(second.requestId));
        expect(new Set([first.requestId, second.requestId, third.requestId]).size).toBe(3);
        const result = yield* Schema.decodeUnknownEffect(Completed)(yield* resume(third.requestId));
        expect(result.execution.ok).toBe(true);
        expect(result.execution.value).toEqual(
          ["one", "two", "three"].map((reviewed) => ({
            path: `tools[${JSON.stringify(app.slug)}].review`,
            ok: true,
            value: { reviewed },
          })),
        );
        expect(result.execution.toolCalls.map(({ outcome }) => outcome)).toEqual([
          "success",
          "success",
          "success",
        ]);
        yield* idle;
        yield* evidence.step(
          "After completion an idle entry restores the same protocol session",
          post({ id: 3, method: "tools/list", params: {} }, session).pipe(
            Effect.tap(({ text }) => Effect.sync(() => expect(text).toContain('"resume"'))),
            Effect.tap(({ traceId }) => restored(traceId)),
          ),
        );
      }),
    ),
  );
  it.effect(scenarios.selfHostMcpLostProgram.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { evidence, pause, resume, post, session } = yield* fixture;
        const first = yield* pause(["before-crash", "after-crash", "never-replayed"]);
        const second = yield* Schema.decodeUnknownEffect(Pending)(yield* resume(first.requestId));
        // Kill, not graceful stop: no finalizer can turn the parked request into an ended record.
        yield* serverControl("kill");
        // The existing runner clock seam lets the dead process's PGlite lock become stale.
        yield* serverControl("clock/advance", 200, { milliseconds: 100_000 });
        yield* serverControl("start");
        const lost = yield* evidence.step(
          "The same Mcp-Session-Id reaches resume after a crash and reports the program lost",
          resume(second.requestId).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Unavailable))),
        );
        expect(lost.reason).toBe("lost");
        expect(lost.pending).toEqual([]);
        expect(lost.message).toContain("no longer holds this program here");
        expect(lost.message).toContain("Earlier calls may have run");
        expect(lost.message).toContain("Never repeat the call or program automatically");
        const answered = yield* Schema.decodeUnknownEffect(Unavailable)(
          yield* resume(first.requestId),
        );
        expect(answered.reason).toBe("answered");
        // A second restart verifies reopening the retained metadata is repeat-safe.
        yield* serverControl("kill");
        yield* serverControl("clock/advance", 200, { milliseconds: 100_000 });
        yield* serverControl("start");
        const again = yield* Schema.decodeUnknownEffect(Unavailable)(
          yield* resume(second.requestId),
        );
        expect(again.reason).toBe("lost");
        yield* post({ id: 3, method: "tools/list", params: {} }, session);
      }),
    ),
  );
});
