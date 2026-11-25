import { expect, layer } from "@effect/vitest";
import { Deferred, Effect, Fiber, Redacted, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomBytes } from "node:crypto";
import { Agent, createServer, request as httpRequest } from "node:http";
import { Agent as TlsAgent, request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Browser } from "../support/browser.ts";
import { McpClient } from "../support/mcp-client.ts";
import { driver, Target } from "../support/platform.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { awaitSentryEvents, sentryEvents, type SentryEvent } from "../support/sentry-events.ts";

const supported = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];

const RpcError = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
});
const Message = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(RpcError),
});
const Initialized = Schema.Struct({ protocolVersion: Schema.String });
const Tools = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) });
const Execution = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});
const CallResult = Schema.Struct({
  content: Schema.Tuple([
    Schema.Struct({ type: Schema.Literal("text"), text: Schema.fromJsonString(Execution) }),
  ]),
});
const SessionId = Schema.NonEmptyString;

const clientTrace = () => {
  const traceId = randomBytes(16).toString("hex");
  return { traceId, traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01` };
};

const send = <E>(
  credentials: Readonly<Record<string, string>>,
  body: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientRequest.HttpClientRequest, E>,
  headers: Readonly<Record<string, string>> = {},
  path = "/mcp",
) =>
  Effect.gen(function* () {
    const target = yield* Target,
      http = yield* HttpClient.HttpClient;
    const { traceId, traceparent } = clientTrace();
    const request = yield* body(
      HttpClientRequest.post(new URL(path, target.metadata.origin), {
        headers: {
          ...credentials,
          accept: "application/json, text/event-stream",
          traceparent,
          ...headers,
        },
      }),
    );
    const response = yield* http.execute(request).pipe(Effect.timeout("30 seconds"));
    const text = yield* response.text;
    const data = response.headers["content-type"]?.startsWith("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data: ") && line.length > 6)
          .map((line) => line.slice(6))
          .at(-1)
      : text;
    const reply =
      data === undefined || data === ""
        ? undefined
        : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Message))(data);
    return {
      status: response.status,
      session: response.headers["mcp-session-id"],
      version: response.headers["mcp-protocol-version"],
      reply,
      traceId,
    };
  }).pipe(Effect.scoped, Effect.provideService(HttpClient.TracerPropagationEnabled, false));

const post = (
  credentials: Readonly<Record<string, string>>,
  message: object,
  headers: Readonly<Record<string, string>> = {},
  path = "/mcp",
) => send(credentials, HttpClientRequest.bodyJson({ jsonrpc: "2.0", ...message }), headers, path);

const keptAliveAgent = Effect.gen(function* () {
  const tls = new URL((yield* Target).metadata.origin).protocol === "https:";
  return yield* Effect.acquireRelease(
    Effect.sync(() =>
      tls
        ? new TlsAgent({ keepAlive: true, maxSockets: 1 })
        : new Agent({ keepAlive: true, maxSockets: 1 }),
    ),
    (agent) => Effect.sync(() => agent.destroy()),
  );
});

const postOn = (agent: Agent, credentials: Readonly<Record<string, string>>, message: object) =>
  Effect.gen(function* () {
    const url = new URL("/mcp", (yield* Target).metadata.origin);
    return yield* driver(
      "POST /mcp on a kept-alive connection",
      (signal) =>
        new Promise<{ outcome: string; text: string; socket: Socket | undefined }>((resolve) => {
          const body = JSON.stringify({ jsonrpc: "2.0", ...message });
          let socket: Socket | undefined;
          const pending = (url.protocol === "https:" ? httpsRequest : httpRequest)(
            url,
            {
              method: "POST",
              agent,
              signal,
              headers: {
                ...credentials,
                accept: "application/json, text/event-stream",
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(body)),
              },
            },
            (response) => {
              let text = "";
              response.setEncoding("utf8");
              response.on("data", (chunk: string) => (text += chunk));
              response.once("close", () =>
                resolve({
                  outcome: response.complete ? String(response.statusCode) : "answer cut short",
                  text,
                  socket,
                }),
              );
            },
          );
          pending.once("socket", (used) => (socket = used));
          pending.on("error", (error: NodeJS.ErrnoException) =>
            resolve({ outcome: error.code ?? error.message, text: "", socket }),
          );
          pending.end(body);
        }),
    );
  });

const expectRejected = (
  rejected: Pick<Effect.Success<ReturnType<typeof send>>, "status" | "reply">,
  status: number,
  mentions: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    expect(rejected.status).toBe(status);
    const error = yield* Schema.decodeUnknownEffect(RpcError)(rejected.reply?.error);
    expect(error.code).toBe(-32600);
    for (const text of mentions) expect(error.message).toContain(text);
  });

const initialize = (
  credentials: Readonly<Record<string, string>>,
  protocolVersion: string,
  capabilities: object = {},
  path = "/mcp",
) =>
  post(
    credentials,
    {
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities,
        clientInfo: { name: `executor-e2e-${protocolVersion}`, version: "1" },
      },
    },
    {},
    path,
  );

const keptSessions = 256;

const openSession = (credentials: Readonly<Record<string, string>>) =>
  initialize(credentials, "2025-11-25").pipe(
    Effect.flatMap((opened) => Schema.decodeUnknownEffect(SessionId)(opened.session)),
  );
const listWith = (credentials: Readonly<Record<string, string>>, session: string) =>
  post({ ...credentials, "mcp-session-id": session }, { id: 2, method: "tools/list" });

const checkSessionBound = (credentials: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const first = yield* openSession(credentials);
    const second = yield* openSession(credentials);
    yield* Effect.forEach(
      Array.from({ length: keptSessions - 2 }),
      () => openSession(credentials),
      {
        concurrency: 8,
        discard: true,
      },
    );
    yield* evidence.step(
      `With ${keptSessions} sessions open, the first still answers`,
      Effect.gen(function* () {
        expect((yield* listWith(credentials, first)).status).toBe(200);
      }),
    );
    const newest = yield* openSession(credentials);
    yield* evidence.step(
      "Opening one more forgets the least recently used session, which is told to initialize again",
      Effect.gen(function* () {
        const rejected = yield* listWith(credentials, second);
        yield* expectRejected(rejected, 404, ["Mcp-Session-Id", "initialize"]);
        yield* evidence.json("forgotten-session.json", rejected.reply);
        expect((yield* listWith(credentials, first)).status).toBe(200);
        expect((yield* listWith(credentials, newest)).status).toBe(200);
      }),
    );
    yield* evidence.step(
      "The forgotten session's client initializes again and continues",
      Effect.gen(function* () {
        const again = yield* openSession(credentials);
        const listed = yield* listWith(credentials, again);
        expect(listed.status).toBe(200);
        const { tools } = yield* Schema.decodeUnknownEffect(Tools)(listed.reply?.result);
        expect(tools.map((tool) => tool.name)).toContain("execute");
      }),
    );
  });

const openSessions = (credentials: Readonly<Record<string, string>>, path: string, count: number) =>
  Effect.forEach(
    Array.from({ length: count }),
    () =>
      initialize(credentials, "2025-11-25", {}, path).pipe(
        Effect.flatMap((opened) => Schema.decodeUnknownEffect(SessionId)(opened.session)),
      ),
    { concurrency: 8, discard: true },
  );

const BrowserPending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
  approvalUrl: Schema.String,
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});

const checkSessionsOwningWork = (
  key: Redacted.Redacted<string>,
  credentials: Readonly<Record<string, string>>,
  slug: string,
  started: (call: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const actors = yield* Actors,
      browser = yield* Browser,
      evidence = yield* Evidence,
      mcp = yield* McpClient;
    const organization = actors.organization.id;
    const services = yield* Effect.context<HttpClient.HttpClient | Target>();
    const approve = `return await tools[${JSON.stringify(slug)}].approved({})`;

    yield* evidence.step(
      "A native client answers an approval prompt after 256 newer sessions open, and the call completes",
      Effect.gen(function* () {
        const native = yield* mcp.connect(key, "bound-native", {
          organization,
          mode: "native",
          whileApproving: openSessions(
            credentials,
            "/mcp?elicitation_mode=native",
            keptSessions,
          ).pipe(Effect.provideContext(services)),
        });
        const answered = yield* native.use("Call a tool that asks for approval", (client, signal) =>
          client.callTool({ name: "execute", arguments: { code: approve } }, undefined, {
            signal,
            timeout: 30_000,
          }),
        );
        expect(yield* native.elicitationCount).toBe(1);
        const completed = yield* Schema.decodeUnknownEffect(Completed)(answered.structuredContent);
        expect(completed.execution.value).toBe("approved");
      }),
    );

    yield* evidence.step(
      "A client cancels its running call after 256 newer sessions open, and the call ends without a result",
      Effect.gen(function* () {
        const opened = yield* initialize(credentials, "2025-11-25");
        const session = {
          ...credentials,
          "mcp-session-id": yield* Schema.decodeUnknownEffect(SessionId)(opened.session),
          "mcp-protocol-version": "2025-11-25",
        };
        const id = crypto.randomUUID();
        const frames: Array<typeof Frame.Type> = [];
        const call = yield* stream(
          session,
          {
            id: 1,
            method: "tools/call",
            params: {
              name: "execute",
              arguments: {
                code: `return await tools[${JSON.stringify(slug)}].wait({ call: ${JSON.stringify(id)} })`,
              },
            },
          },
          "/mcp",
          frames,
          yield* Deferred.make<void>(),
        ).pipe(Effect.forkScoped);
        yield* started(id).pipe(Effect.timeout("60 seconds"));
        yield* openSessions(credentials, "/mcp", keptSessions);
        const cancelled = yield* post(session, {
          method: "notifications/cancelled",
          params: { requestId: 1, reason: "The client stopped waiting" },
        });
        expect(cancelled.status).toBe(202);
        const ended = yield* Fiber.join(call).pipe(Effect.timeout("15 seconds"));
        expect(ended.status).toBe(200);
        expect(frames.filter((frame) => frame.id === 1 && frame.method === undefined)).toEqual([]);
      }).pipe(Effect.scoped),
    );

    yield* evidence.step(
      "A browser program approved on its review page after 256 newer sessions open resumes in its own session",
      Effect.gen(function* () {
        yield* browser.login(actors.owner);
        const linked = yield* mcp.connect(key, "bound-browser", { organization, mode: "browser" });
        const pending = yield* linked
          .use("Call a tool that asks for approval in the browser", (client, signal) =>
            client.callTool({ name: "execute", arguments: { code: approve } }, undefined, {
              signal,
              timeout: 55_000,
            }),
          )
          .pipe(
            Effect.flatMap((result) =>
              Schema.decodeUnknownEffect(BrowserPending)(result.structuredContent),
            ),
          );
        yield* openSessions(credentials, "/mcp?elicitation_mode=browser", keptSessions);
        const url = new URL(pending.approvalUrl);
        yield* browser.use("Open the review page and approve", (page) =>
          page
            .goto(`${url.pathname}${url.search}`)
            .then(() =>
              page.getByRole("heading", { name: "Review tool request", exact: true }).waitFor(),
            )
            .then(() => page.getByRole("button", { name: "Approve", exact: true }).click())
            .then(() => page.getByText("Response saved", { exact: true }).waitFor()),
        );
        yield* browser.checkpoint("Approval saved after 256 newer sessions opened");
        const resumed = yield* linked.use("Collect the approval through resume", (client, signal) =>
          client.callTool(
            { name: "resume", arguments: { requestId: pending.requestId } },
            undefined,
            { signal, timeout: 55_000 },
          ),
        );
        const completed = yield* Schema.decodeUnknownEffect(Completed)(resumed.structuredContent);
        expect(completed.execution.value).toBe("approved");
      }),
    );
  });

const checkProtocolVersions = (credentials: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const negotiated: Record<string, string> = {};
    for (const offered of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"])
      yield* evidence.step(
        `A client offering ${offered} initializes, lists and calls tools without the version header`,
        Effect.gen(function* () {
          const opened = yield* initialize(credentials, offered);
          expect(opened.status).toBe(200);
          const { protocolVersion } = yield* Schema.decodeUnknownEffect(Initialized)(
            opened.reply?.result,
          );
          expect(protocolVersion).toBe(supported.includes(offered) ? offered : "2025-11-25");
          expect(opened.version).toBe(protocolVersion);
          negotiated[offered] = protocolVersion;
          const session = {
            ...credentials,
            "mcp-session-id": yield* Schema.decodeUnknownEffect(SessionId)(opened.session),
          };
          expect((yield* post(session, { method: "notifications/initialized" })).status).toBe(202);
          const listed = yield* post(session, { id: 2, method: "tools/list" });
          expect(listed.status).toBe(200);
          expect(listed.version).toBe(protocolVersion);
          const { tools } = yield* Schema.decodeUnknownEffect(Tools)(listed.reply?.result);
          expect(tools.map((tool) => tool.name).sort()).toEqual([
            "call",
            "describe",
            "execute",
            "resume",
            "search",
            "skills",
          ]);
          const called = yield* post(session, {
            id: 3,
            method: "tools/call",
            params: { name: "execute", arguments: { code: "return 40 + 2" } },
          });
          expect(called.status).toBe(200);
          const result = yield* Schema.decodeUnknownEffect(CallResult)(called.reply?.result);
          expect(result.content[0].text.execution.value).toBe(42);
        }),
      );
    yield* evidence.json("negotiated-versions.json", negotiated);

    const opened = yield* initialize(credentials, "2025-11-25");
    const session = {
      ...credentials,
      "mcp-session-id": yield* Schema.decodeUnknownEffect(SessionId)(opened.session),
    };
    yield* evidence.step(
      "An unsupported MCP-Protocol-Version header is rejected with the supported versions",
      Effect.gen(function* () {
        const rejected = yield* post(
          session,
          { id: 4, method: "tools/list" },
          { "mcp-protocol-version": "2024-11-05" },
        );
        expect(rejected.status).toBe(400);
        const error = yield* Schema.decodeUnknownEffect(RpcError)(rejected.reply?.error);
        expect(error.code).toBe(-32022);
        expect(error.data).toEqual({ supported, requested: "2024-11-05" });
        expect(error.message).toContain("2024-11-05");
        for (const version of supported) expect(error.message).toContain(version);
        yield* evidence.json("unsupported-version.json", rejected.reply);
      }),
    );
    yield* evidence.step(
      "A header naming another version than the session's is rejected with both versions",
      Effect.gen(function* () {
        const rejected = yield* post(
          session,
          { id: 5, method: "tools/list" },
          { "mcp-protocol-version": "2025-06-18" },
        );
        expect(rejected.status).toBe(400);
        const error = yield* Schema.decodeUnknownEffect(RpcError)(rejected.reply?.error);
        expect(error.code).toBe(-32020);
        expect(error.message).toContain("2025-06-18");
        expect(error.message).toContain("2025-11-25");
        yield* evidence.json("mismatched-version.json", rejected.reply);
      }),
    );
    yield* evidence.step(
      "A request without a session is told to initialize first",
      Effect.gen(function* () {
        const rejected = yield* post(credentials, { id: 6, method: "tools/list" });
        expect(rejected.status).toBe(400);
        const error = yield* Schema.decodeUnknownEffect(RpcError)(rejected.reply?.error);
        expect(error.code).toBe(-32600);
        expect(error.message).toContain("Mcp-Session-Id");
        expect(error.message).toContain("initialize");
        yield* evidence.json("missing-session.json", rejected.reply);
      }),
    );
    yield* evidence.step(
      "A request with an unknown session is told to initialize again, and its client keeps its connection",
      Effect.gen(function* () {
        const agent = yield* keptAliveAgent;
        const refused = yield* postOn(
          agent,
          { ...credentials, "mcp-session-id": crypto.randomUUID() },
          { id: 7, method: "tools/list" },
        );
        const rejected = {
          status: Number(refused.outcome),
          reply: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Message))(refused.text),
        };
        yield* expectRejected(rejected, 404, ["Mcp-Session-Id", "initialize"]);
        yield* evidence.json("unknown-session.json", rejected.reply);
        const next = yield* postOn(agent, session, { id: 12, method: "tools/list" });
        expect(
          {
            outcome: next.outcome,
            connection: next.socket === refused.socket ? "same" : "another",
          },
          "The client's next request goes on its connection and is answered",
        ).toEqual({ outcome: "200", connection: "same" });
      }).pipe(Effect.scoped),
    );
    yield* evidence.step(
      "Wrong media types and a batch are told what to send",
      Effect.gen(function* () {
        const accept = yield* post(
          session,
          { id: 8, method: "tools/list" },
          { accept: "application/json" },
        );
        yield* expectRejected(accept, 406, ["Accept", "text/event-stream"]);
        const contentType = yield* send(session, (request) =>
          Effect.succeed(
            HttpClientRequest.bodyText(
              request,
              JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
              "text/plain",
            ),
          ),
        );
        yield* expectRejected(contentType, 415, ["Content-Type", "application/json"]);
        const batch = yield* send(
          session,
          HttpClientRequest.bodyJson([
            { jsonrpc: "2.0", id: 10, method: "tools/list" },
            { jsonrpc: "2.0", id: 11, method: "tools/list" },
          ]),
        );
        yield* expectRejected(batch, 400, ["batches"]);
        yield* evidence.json("media-types.json", {
          accept: accept.reply,
          contentType: contentType.reply,
          batch: batch.reply,
        });
      }),
    );
  });

const startSignals = Effect.gen(function* () {
  const calls = new Map<string, Deferred.Deferred<void>>();
  const signal = (call: string) => {
    const known = calls.get(call);
    if (known !== undefined) return known;
    const created = Deferred.makeUnsafe<void>();
    calls.set(call, created);
    return created;
  };
  const server = createServer((request, response) => {
    const call = new URL(request.url ?? "/", "http://signal.internal").searchParams.get("call");
    if (call !== null) Deferred.doneUnsafe(signal(call), Effect.void);
    response.writeHead(204).end();
  });
  const port = yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resume(
          typeof address === "object" && address !== null
            ? Effect.succeed(address.port)
            : Effect.die("The start signal needs a TCP listener"),
        );
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );
  return {
    origin: `http://127.0.0.1:${port}`,
    started: (call: string) => Deferred.await(signal(call)),
  };
});

const deployWaitingApp = (name: string, signals: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const root = `/api/organizations/${actors.organization.id}`;
    const deployed = yield* api.request(actors.owner, "POST", `${root}/apps/deploy`, {
      name,
      files: [
        {
          path: "index.ts",
          content: `import { defineApp, mutation, object, query, router, string } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, { tools: router({
  wait: query({ input: object({ call: string() }) }, async (_ctx, { call }) => {
    await fetch(${JSON.stringify(`${signals}/started?call=`)} + encodeURIComponent(call));
    await new Promise((resolve) => setTimeout(resolve, 25_000));
    return "finished";
  }),
  approved: mutation({ input: object({}), approval: always() }, async () => "approved"),
}) });`,
        },
        appsManifest,
      ],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed);
    yield* Effect.addFinalizer(() =>
      api.request(actors.owner, "DELETE", `${root}/apps/${app.id}`).pipe(Effect.orDie),
    );
    return app;
  });

const stream = (
  credentials: Readonly<Record<string, string>>,
  message: object,
  path: string,
  frames: Array<typeof Frame.Type>,
  first: Deferred.Deferred<void>,
) =>
  Effect.gen(function* () {
    const target = yield* Target,
      http = yield* HttpClient.HttpClient;
    const { traceId, traceparent } = clientTrace();
    const response = yield* http.execute(
      HttpClientRequest.post(new URL(path, target.metadata.origin), {
        headers: { ...credentials, accept: "application/json, text/event-stream", traceparent },
      }).pipe(HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", ...message })),
    );
    yield* response.stream.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.startsWith("data: ")),
      Stream.mapEffect((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Frame))(line.slice(6)),
      ),
      Stream.runForEach((frame) =>
        Effect.sync(() => frames.push(frame)).pipe(
          Effect.andThen(Deferred.succeed(first, undefined)),
        ),
      ),
    );
    return { status: response.status, contentType: response.headers["content-type"], traceId };
  }).pipe(Effect.scoped, Effect.provideService(HttpClient.TracerPropagationEnabled, false));

const Frame = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});

const checkCancelledCalls = (
  credentials: Readonly<Record<string, string>>,
  slug: string,
  started: (call: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const outcomes: Record<string, unknown> = {};
    const traces: Array<string> = [];
    const cancelledCall = (input: {
      readonly version: string;
      readonly path: string;
      readonly capabilities: object;
      readonly code: string;
      readonly running: (first: Deferred.Deferred<void>) => Effect.Effect<void>;
    }) =>
      Effect.gen(function* () {
        const opened = yield* initialize(
          credentials,
          input.version,
          input.capabilities,
          input.path,
        );
        expect(opened.status).toBe(200);
        const session = {
          ...credentials,
          "mcp-session-id": yield* Schema.decodeUnknownEffect(SessionId)(opened.session),
          "mcp-protocol-version": input.version,
        };
        const frames: Array<typeof Frame.Type> = [];
        const first = yield* Deferred.make<void>();
        const call = yield* stream(
          session,
          {
            id: 1,
            method: "tools/call",
            params: { name: "execute", arguments: { code: input.code } },
          },
          input.path,
          frames,
          first,
        ).pipe(Effect.forkScoped);
        yield* input.running(first).pipe(Effect.timeout("60 seconds"));
        const cancelled = yield* post(
          session,
          {
            method: "notifications/cancelled",
            params: { requestId: 1, reason: "The client stopped waiting" },
          },
          {},
          input.path,
        );
        expect(cancelled.status).toBe(202);
        expect(cancelled.reply).toBeUndefined();
        const ended = yield* Fiber.join(call).pipe(Effect.timeout("30 seconds"));
        expect(ended.status).toBe(200);
        expect(ended.contentType).toMatch(/^text\/event-stream/);
        expect(frames.filter((frame) => frame.id === 1 && frame.method === undefined)).toEqual([]);
        const called = yield* post(
          session,
          {
            id: 2,
            method: "tools/call",
            params: { name: "execute", arguments: { code: "return 40 + 2" } },
          },
          {},
          input.path,
        );
        expect(called.status).toBe(200);
        const result = yield* Schema.decodeUnknownEffect(CallResult)(called.reply?.result);
        expect(result.content[0].text.execution.value).toBe(42);
        traces.push(opened.traceId, ended.traceId, cancelled.traceId, called.traceId);
        return {
          status: ended.status,
          contentType: ended.contentType,
          frames: frames.map((frame) => frame.method ?? "response"),
        };
      }).pipe(Effect.scoped);
    for (const version of ["2025-06-18", "2025-11-25"]) {
      yield* evidence.step(
        `A ${version} call cancelled while its app tool runs, before any output, ends its stream without a result`,
        Effect.gen(function* () {
          const id = crypto.randomUUID();
          outcomes[`${version} before output`] = yield* cancelledCall({
            version,
            path: "/mcp",
            capabilities: {},
            code: `return await tools[${JSON.stringify(slug)}].wait({ call: ${JSON.stringify(id)} })`,
            running: () => started(id),
          });
        }),
      );
      yield* evidence.step(
        `A ${version} call cancelled after it streamed an approval request ends its stream without a result`,
        Effect.gen(function* () {
          const outcome = yield* cancelledCall({
            version,
            path: "/mcp?elicitation_mode=native",
            capabilities: { elicitation: version === "2025-06-18" ? {} : { form: {} } },
            code: `return await tools[${JSON.stringify(slug)}].approved({})`,
            running: (first) => Deferred.await(first),
          });
          expect(outcome.frames[0]).toBe("elicitation/create");
          outcomes[`${version} after a frame`] = outcome;
        }),
      );
    }
    yield* evidence.json("cancelled-calls.json", outcomes);
    if ((yield* Target).metadata.target === "cloud") {
      const reported = (events: ReadonlyArray<SentryEvent>) =>
        events
          .flatMap((event) => event.exception?.values ?? [])
          .filter(
            (exception) => exception.type === "Done" || exception.type === "McpResponseNotWritten",
          );
      const events = yield* awaitSentryEvents(traces, (events) => reported(events).length > 0).pipe(
        Effect.catchTag("TimeoutError", () => sentryEvents(traces)),
      );
      expect(reported(events)).toEqual([]);
    }
  });

const apiKey = (name: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", { name }),
    );
    yield* Effect.addFinalizer(() =>
      api
        .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
        .pipe(Effect.orDie),
    );
    return {
      key: key.key,
      credentials: {
        authorization: `Bearer ${Redacted.value(key.key)}`,
        "x-executor-organization": actors.organization.id,
      },
    };
  });
const keyCredentials = (name: string) => Effect.map(apiKey(name), ({ credentials }) => credentials);

layer(HostedLive, { excludeTestServices: true })("Hosted MCP protocol versions", (it) => {
  it.effect(scenarios.mcpProtocolVersions.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        yield* checkProtocolVersions(yield* keyCredentials("MCP protocol versions"));
      }),
    ),
  );

  it.effect(scenarios.mcpSessionBound.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        yield* checkSessionBound(yield* keyCredentials("MCP session bound"));
      }),
    ),
  );

  it.effect(scenarios.mcpSessionBoundWork.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { key, credentials } = yield* apiKey("MCP sessions owning work");
        const signals = yield* startSignals;
        const app = yield* deployWaitingApp("Sessions owning work", signals.origin);
        yield* checkSessionsOwningWork(key, credentials, app.slug, signals.started);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpCancelledCalls.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const credentials = yield* keyCredentials("MCP cancelled calls");
        const signals = yield* startSignals;
        const app = yield* deployWaitingApp("Cancelled call", signals.origin);
        yield* checkCancelledCalls(credentials, app.slug, signals.started);
      }),
    ),
  );
});
