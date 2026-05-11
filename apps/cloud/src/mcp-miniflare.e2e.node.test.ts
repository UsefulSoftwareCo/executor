// ---------------------------------------------------------------------------
// Real-port Miniflare e2e for the cloud MCP server.
// ---------------------------------------------------------------------------
//
// wrangler's `unstable_dev` boots the test-worker.ts entry on a real local
// port via Miniflare. The MCP SDK `Client` + `StreamableHTTPClientTransport`
// then drive `/mcp` exactly like a production client would — no hand-rolled
// JSON-RPC, no workerd-pool cross-request I/O workaround.
//
// `mcp-flow.test.ts` (workerd pool) rebuilds the DO runtime per request
// because workerd-pool's strict cross-request I/O check rejects a long-lived
// postgres socket; Miniflare on a real port has no such check, so this
// suite exercises the actual long-lived-socket DO runtime.
//
// Elicitation coverage uses the openapi plugin: a tiny Effect HttpApi
// upstream is stood up in-process, its generated spec is handed to
// `tools.executor.openapi.addSource`, and the cloud engine invokes a POST operation.
// `requiresApproval: true` fires the executor's approval elicitation, which
// round-trips back to the SDK Client's `ElicitRequestSchema` handler.
// ---------------------------------------------------------------------------

import { expect, layer } from "@effect/vitest";
import { resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Context, Data, Effect, Layer, Option, Predicate, Schema } from "effect";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

import { makeTestBearer } from "./test-bearer";

// ---------------------------------------------------------------------------
// Upstream test API — declared once via Effect's `HttpApi` so the spec the
// cloud engine consumes is derived from the same types the handlers use.
// ---------------------------------------------------------------------------

class ApprovedResponse extends Schema.Class<ApprovedResponse>("ApprovedResponse")({
  approved: Schema.Boolean,
}) {}

const ApproveGroup = HttpApiGroup.make("approve").add(
  HttpApiEndpoint.post("approveThing", "/approve", {
    success: ApprovedResponse,
  }),
);

const UpstreamApi = HttpApi.make("approveApi").add(ApproveGroup);

const ApproveHandlers = HttpApiBuilder.group(UpstreamApi, "approve", (h) =>
  h.handle("approveThing", () => Effect.succeed(new ApprovedResponse({ approved: true }))),
);

const UpstreamApiLive = HttpApiBuilder.layer(UpstreamApi).pipe(Layer.provide(ApproveHandlers));

const UpstreamServeLayer = HttpRouter.serve(UpstreamApiLive).pipe(
  Layer.provide(UpstreamApiLive),
  Layer.provideMerge(HttpRouter.layer),
  Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0, host: "127.0.0.1" })),
);

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

class Upstream extends Context.Service<
  Upstream,
  { readonly specJson: string; readonly url: string }
>()("MiniflareE2E/Upstream") {}

class Worker extends Context.Service<
  Worker,
  {
    readonly baseUrl: URL;
    readonly seedOrg: (id: string, name: string) => Promise<void>;
  }
>()("MiniflareE2E/Worker") {}

type CapturedSpan = {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly attributes: Record<string, unknown>;
};

class TelemetryReceiver extends Context.Service<
  TelemetryReceiver,
  {
    readonly tracesUrl: string;
    readonly spans: () => ReadonlyArray<CapturedSpan>;
    readonly waitForSpan: (
      predicate: (span: CapturedSpan) => boolean,
      timeoutMs?: number,
    ) => Promise<CapturedSpan>;
  }
>()("MiniflareE2E/TelemetryReceiver") {}

class MiniflareE2ETestError extends Data.TaggedError("MiniflareE2ETestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const UpstreamLive = Layer.effect(
  Upstream,
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const addr = server.address;
    if (!Predicate.isTagged("TcpAddress")(addr)) {
      return yield* new MiniflareE2ETestError({
        message: "upstream server bound to non-TCP address",
        cause: addr,
      });
    }
    const url = `http://127.0.0.1:${addr.port}`;
    const specJson = JSON.stringify({
      ...OpenApi.fromApi(UpstreamApi),
      servers: [{ url }],
    });
    return { specJson, url };
  }),
).pipe(Layer.provide(UpstreamServeLayer));

// ---------------------------------------------------------------------------
// Telemetry receiver — a node HTTP server on a random port that speaks
// OTLP/JSON. The Effect OTLPTraceExporter in `services/telemetry.ts`
// posts JSON bodies to it (confirmed via
// `@opentelemetry/exporter-trace-otlp-http` — `Content-Type:
// application/json` + `JsonTraceSerializer`). We parse resourceSpans →
// scopeSpans → spans → attributes so tests can assert the DO actually
// reported the expected spans, not just that the exporter was called.
// ---------------------------------------------------------------------------

const OtlpAttributeValue = Schema.Struct({
  stringValue: Schema.optional(Schema.String),
  intValue: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  doubleValue: Schema.optional(Schema.Number),
  boolValue: Schema.optional(Schema.Boolean),
});
type OtlpAttributeValue = typeof OtlpAttributeValue.Type;

const OtlpPayloadFromJson = Schema.fromJsonString(
  Schema.Struct({
    resourceSpans: Schema.optional(
      Schema.Array(
        Schema.Struct({
          scopeSpans: Schema.optional(
            Schema.Array(
              Schema.Struct({
                spans: Schema.optional(
                  Schema.Array(
                    Schema.Struct({
                      name: Schema.String,
                      traceId: Schema.optional(Schema.String),
                      spanId: Schema.optional(Schema.String),
                      parentSpanId: Schema.optional(Schema.String),
                      attributes: Schema.optional(
                        Schema.Array(
                          Schema.Struct({
                            key: Schema.String,
                            value: Schema.optional(OtlpAttributeValue),
                          }),
                        ),
                      ),
                    }),
                  ),
                ),
              }),
            ),
          ),
        }),
      ),
    ),
  }),
);

const decodeOtlpPayload = Schema.decodeUnknownOption(OtlpPayloadFromJson);

const unwrapAttrValue = (v?: OtlpAttributeValue): unknown => {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return undefined;
};

const TelemetryReceiverLive = Layer.effect(TelemetryReceiver)(
  Effect.acquireRelease(
    Effect.callback<
      {
        readonly tracesUrl: string;
        readonly spans: ReadonlyArray<CapturedSpan>;
        readonly store: Array<CapturedSpan>;
        readonly close: () => Promise<void>;
      },
      never
    >((resume) => {
      const store: Array<CapturedSpan> = [];
      const server = createServer((req, res) => {
        if (req.method !== "POST" || !req.url?.endsWith("/v1/traces")) {
          res.statusCode = 404;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          const maybePayload = decodeOtlpPayload(body);
          if (Option.isSome(maybePayload)) {
            const payload = maybePayload.value;
            for (const rs of payload.resourceSpans ?? []) {
              for (const ss of rs.scopeSpans ?? []) {
                for (const sp of ss.spans ?? []) {
                  const attrs: Record<string, unknown> = {};
                  for (const a of sp.attributes ?? []) {
                    attrs[a.key] = unwrapAttrValue(a.value);
                  }
                  store.push({
                    name: sp.name,
                    traceId: sp.traceId ?? "",
                    spanId: sp.spanId ?? "",
                    parentSpanId: sp.parentSpanId ? sp.parentSpanId : null,
                    attributes: attrs,
                  });
                }
              }
            }
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        resume(
          Effect.succeed({
            tracesUrl: `http://127.0.0.1:${addr.port}/v1/traces`,
            spans: store,
            store,
            close: () => new Promise<void>((r) => server.close(() => r())),
          }),
        );
      });
    }),
    (t) => Effect.promise(() => t.close()),
  ).pipe(
    Effect.map((t) => ({
      tracesUrl: t.tracesUrl,
      spans: () => [...t.store],
      waitForSpan: (predicate: (s: CapturedSpan) => boolean, timeoutMs = 5_000) =>
        Effect.gen(function* () {
          const poll = Effect.gen(function* () {
            for (;;) {
              const hit = t.store.find(predicate);
              if (hit) return hit;
              yield* Effect.sleep("50 millis");
            }
          });
          return yield* poll.pipe(
            Effect.timeoutOrElse({
              duration: `${timeoutMs} millis`,
              orElse: () =>
                Effect.fail(
                  new MiniflareE2ETestError({
                    message: `Timed out waiting for span. Captured ${t.store.length}: ${t.store.map((s) => s.name).join(", ") || "<none>"}`,
                  }),
                ),
            }),
          );
        }).pipe(Effect.runPromise),
    })),
  ),
);

const WorkerLive = Layer.effect(Worker)(
  Effect.gen(function* () {
    const receiver = yield* TelemetryReceiver;
    // AXIOM_TOKEN activates DoTelemetryLive inside the worker; AXIOM_TRACES_URL
    // redirects the exporter at our in-process OTLP/JSON receiver so spans
    // become observable in the test process.
    return yield* Effect.acquireRelease(
      Effect.promise(() =>
        unstable_dev(resolve(__dirname, "./test-worker.ts"), {
          config: resolve(__dirname, "../wrangler.miniflare.jsonc"),
          experimental: { disableExperimentalWarning: true },
          ip: "127.0.0.1",
          logLevel: "info",
          vars: {
            AXIOM_TOKEN: "test-token",
            AXIOM_TRACES_URL: receiver.tracesUrl,
          },
        }),
      ),
      (w) => Effect.promise(() => w.stop()),
    ).pipe(
      Effect.map((w: Unstable_DevWorker) => ({
        baseUrl: new URL(`http://${w.address}:${w.port}`),
        seedOrg: async (id: string, name: string) => {
          const res = await w.fetch("/__test__/seed-org", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id, name }),
          });
          if (res.status !== 204) {
            return Effect.runPromise(
              Effect.fail(
                new MiniflareE2ETestError({
                  message: `seed-org failed: ${res.status} ${await res.text()}`,
                }),
              ),
            );
          }
        },
      })),
    );
  }),
);

const TestEnv = Layer.mergeAll(UpstreamLive, WorkerLive).pipe(
  Layer.provideMerge(TelemetryReceiverLive),
);

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

let accountCounter = 0;
let orgCounter = 0;
const nextAccountId = () => `acct_miniflare_${++accountCounter}`;
const nextOrgId = () => `org_miniflare_${++orgCounter}`;

const connectClient = async (
  baseUrl: URL,
  bearer: string,
  options: { withElicitation?: boolean } = {},
): Promise<Client> => {
  const client = new Client(
    { name: "mcp-miniflare-e2e", version: "0.0.1" },
    {
      capabilities: options.withElicitation ? { elicitation: { form: {} } } : {},
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  return client;
};

const ignoreCancelBody = (body: ReadableStream<Uint8Array> | null): Effect.Effect<void> =>
  body
    ? Effect.ignore(
        Effect.tryPromise({
          try: () => body.cancel(),
          catch: (cause) =>
            new MiniflareE2ETestError({ message: "Failed to cancel response body", cause }),
        }),
      )
    : Effect.void;

const ignoreCancelReader = (
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
): Effect.Effect<void> =>
  reader
    ? Effect.ignore(
        Effect.tryPromise({
          try: () => reader.cancel(),
          catch: (cause) =>
            new MiniflareE2ETestError({ message: "Failed to cancel response reader", cause }),
        }),
      )
    : Effect.void;

const withTestTimeout = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  message: string,
): Effect.Effect<A, E | MiniflareE2ETestError, R> =>
  self.pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new MiniflareE2ETestError({ message })),
    }),
  );

const initializeSession = async (baseUrl: URL, bearer: string): Promise<string> => {
  const response = await fetch(new URL("/mcp", baseUrl), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "mcp-miniflare-manual", version: "0" },
      },
    }),
  });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).toEqual(expect.any(String));
  await response.text();

  const initialized = await fetch(new URL("/mcp", baseUrl), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      "mcp-session-id": sessionId ?? "",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
  expect(initialized.status).toBe(202);
  await initialized.text();

  return sessionId ?? "";
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

layer(TestEnv, { timeout: 60_000 })("cloud MCP over real HTTP (miniflare)", (it) => {
  it.effect(
    "returns 401 for malformed bearer tokens through the production auth layer",
    () =>
      Effect.gen(function* () {
        const { baseUrl } = yield* Worker;
        const response = yield* Effect.promise(() =>
          fetch(new URL("/__test__/real-auth-mcp", baseUrl), {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              authorization: "Bearer bogus.bogus.bogus",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "mcp-miniflare-invalid-bearer", version: "0" },
              },
            }),
          }),
        );
        expect(response.status).toBe(401);
        const wwwAuth = response.headers.get("www-authenticate") ?? "";
        expect(wwwAuth).toContain('Bearer error="invalid_token"');
        expect(wwwAuth).toContain('error_description="The access token is invalid"');
        expect(wwwAuth).toContain(
          "https://test-resource.example.com/.well-known/oauth-protected-resource/mcp",
        );
        const body = yield* Effect.promise(() => response.json());
        expect(body).toEqual({ error: "unauthorized" });
      }),
    30_000,
  );

  it.effect(
    "completes the initialize handshake via SDK",
    () =>
      Effect.gen(function* () {
        const { baseUrl, seedOrg } = yield* Worker;
        const orgId = nextOrgId();
        yield* Effect.promise(() => seedOrg(orgId, "Miniflare Org"));
        const client = yield* Effect.promise(() =>
          connectClient(baseUrl, makeTestBearer(nextAccountId(), orgId)),
        );
        expect(client.getServerVersion()?.name).toBe("executor");
        yield* Effect.promise(() => client.close());
      }),
    30_000,
  );

  it.effect(
    "lists the execute tool after handshake",
    () =>
      Effect.gen(function* () {
        const { baseUrl, seedOrg } = yield* Worker;
        const orgId = nextOrgId();
        yield* Effect.promise(() => seedOrg(orgId, "List Tools Org"));
        const client = yield* Effect.promise(() =>
          connectClient(baseUrl, makeTestBearer(nextAccountId(), orgId)),
        );
        const { tools } = yield* Effect.promise(() => client.listTools());
        expect(tools.map((t) => t.name)).toContain("execute");
        yield* Effect.promise(() => client.close());
      }),
    30_000,
  );

  it.effect(
    "executes code end-to-end via tools/call",
    () =>
      Effect.gen(function* () {
        const { baseUrl, seedOrg } = yield* Worker;
        const orgId = nextOrgId();
        yield* Effect.promise(() => seedOrg(orgId, "Execute Org"));
        const client = yield* Effect.promise(() =>
          connectClient(baseUrl, makeTestBearer(nextAccountId(), orgId)),
        );
        const result = yield* Effect.promise(() =>
          client.callTool({ name: "execute", arguments: { code: "return 1 + 2" } }),
        );
        expect(result.isError).not.toBe(true);
        const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
        expect(content.find((c) => c.type === "text")?.text ?? "").toContain("3");
        yield* Effect.promise(() => client.close());
      }),
    30_000,
  );

  it.effect(
    "replaces duplicate standalone SSE GET streams for the same session",
    () =>
      Effect.gen(function* () {
        const { baseUrl, seedOrg } = yield* Worker;
        const orgId = nextOrgId();
        const bearer = makeTestBearer(nextAccountId(), orgId);
        yield* Effect.promise(() => seedOrg(orgId, "Duplicate SSE Org"));
        const sessionId = yield* Effect.promise(() => initializeSession(baseUrl, bearer));

        const getHeaders = {
          accept: "text/event-stream",
          authorization: `Bearer ${bearer}`,
          "mcp-protocol-version": "2025-11-25",
          "mcp-session-id": sessionId,
        };
        const first = yield* Effect.promise(() =>
          fetch(new URL("/mcp", baseUrl), { method: "GET", headers: getHeaders }),
        );
        expect(first.status).toBe(200);

        const second = yield* Effect.promise(() =>
          fetch(new URL("/mcp", baseUrl), { method: "GET", headers: getHeaders }),
        );
        expect(second.status).toBe(200);
        expect(second.headers.get("content-type") ?? "").toContain("text/event-stream");

        yield* ignoreCancelBody(first.body);
        yield* ignoreCancelBody(second.body);
      }),
    30_000,
  );

  it.effect(
    "does not replace the active standalone SSE stream for an invalid GET",
    () =>
      Effect.gen(function* () {
        const { baseUrl, seedOrg } = yield* Worker;
        const orgId = nextOrgId();
        const bearer = makeTestBearer(nextAccountId(), orgId);
        yield* Effect.promise(() => seedOrg(orgId, "Invalid SSE Replacement Org"));
        const sessionId = yield* Effect.promise(() => initializeSession(baseUrl, bearer));

        const getHeaders = {
          accept: "text/event-stream",
          authorization: `Bearer ${bearer}`,
          "mcp-protocol-version": "2025-11-25",
          "mcp-session-id": sessionId,
        };
        const first = yield* Effect.promise(() =>
          fetch(new URL("/mcp", baseUrl), { method: "GET", headers: getHeaders }),
        );
        expect(first.status).toBe(200);
        const firstReader = first.body?.getReader();
        expect(firstReader).toBeDefined();

        const invalid = yield* Effect.promise(() =>
          fetch(new URL("/mcp", baseUrl), {
            method: "GET",
            headers: { ...getHeaders, "mcp-protocol-version": "1999-01-01" },
          }),
        );
        expect(invalid.status).toBe(400);
        yield* Effect.promise(() => invalid.text());

        const firstRead = yield* Effect.promise(() =>
          Promise.race([
            firstReader!.read().then(() => "closed"),
            new Promise<"open">((resolve) => setTimeout(() => resolve("open"), 100)),
          ]),
        );
        expect(firstRead).toBe("open");

        yield* ignoreCancelReader(firstReader);
      }),
    30_000,
  );

  it.effect(
    "returns tools/call results while standalone SSE GET reconnects churn",
    () =>
      Effect.gen(function* () {
        const { baseUrl, seedOrg } = yield* Worker;
        const orgId = nextOrgId();
        const bearer = makeTestBearer(nextAccountId(), orgId);
        yield* Effect.promise(() => seedOrg(orgId, "SSE Reconnect Churn Org"));
        const sessionId = yield* Effect.promise(() => initializeSession(baseUrl, bearer));

        const getHeaders = {
          accept: "text/event-stream",
          authorization: `Bearer ${bearer}`,
          "mcp-protocol-version": "2025-11-25",
          "mcp-session-id": sessionId,
        };

        const openSse = () =>
          fetch(new URL("/mcp", baseUrl), { method: "GET", headers: getHeaders });

        const postResult = fetch(new URL("/mcp", baseUrl), {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
            "mcp-protocol-version": "2025-11-25",
            "mcp-session-id": sessionId,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "search",
            method: "tools/call",
            params: {
              name: "execute",
              arguments: {
                code: [
                  "await new Promise((resolve) => setTimeout(resolve, 1_000));",
                  'return await tools.search({ namespace: "vercel_api", query: "list domains", limit: 8 });',
                ].join("\n"),
              },
            },
          }),
        });

        const reconnects = yield* Effect.promise(async () => {
          const responses: Array<Response> = [];
          for (let i = 0; i < 35; i++) {
            const response = await openSse();
            expect(response.status).toBe(200);
            responses.push(response);
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return responses;
        });

        const response = yield* withTestTimeout(
          Effect.promise(() => postResult),
          "tools/call did not return during SSE churn",
        );
        expect(response.status).toBe(200);
        const body = (yield* Effect.promise(() => response.json())) as {
          readonly jsonrpc?: string;
          readonly id?: string;
          readonly result?: { readonly content?: ReadonlyArray<{ readonly text?: string }> };
          readonly error?: unknown;
        };
        expect(body).toMatchObject({ jsonrpc: "2.0", id: "search" });
        expect(body.error).toBeUndefined();
        expect(body.result).toBeDefined();

        yield* Effect.all(
          reconnects.map((response) => ignoreCancelBody(response.body)),
          {
            concurrency: "unbounded",
          },
        );
      }),
    30_000,
  );

  it.effect(
    "returns both overlapping tools/call responses when JSON-RPC ids collide",
    () =>
      Effect.gen(function* () {
        const { baseUrl, seedOrg } = yield* Worker;
        const orgId = nextOrgId();
        const bearer = makeTestBearer(nextAccountId(), orgId);
        yield* Effect.promise(() => seedOrg(orgId, "Overlapping Request Id Org"));
        const sessionId = yield* Effect.promise(() => initializeSession(baseUrl, bearer));

        const postExecute = (code: string) =>
          fetch(new URL("/mcp", baseUrl), {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${bearer}`,
              "content-type": "application/json",
              "mcp-protocol-version": "2025-11-25",
              "mcp-session-id": sessionId,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "execute", arguments: { code } },
            }),
          });

        const first = postExecute(
          ["await new Promise((resolve) => setTimeout(resolve, 500));", 'return "first";'].join(
            "\n",
          ),
        );
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
        const second = postExecute('return "second";');

        const responses = yield* withTestTimeout(
          Effect.promise(() => Promise.all([first, second])),
          "overlapping tools/call requests did not both return",
        );

        expect(responses.map((response) => response.status)).toEqual([200, 200]);
        const bodies = yield* Effect.promise(() =>
          Promise.all(
            responses.map(
              (response) =>
                response.json() as Promise<{
                  readonly result?: {
                    readonly content?: ReadonlyArray<{ readonly text?: string }>;
                  };
                  readonly error?: unknown;
                }>,
            ),
          ),
        );
        expect(
          bodies.some((body) => body.result?.content?.some((item) => item.text?.includes("first"))),
        ).toBe(true);
        expect(
          bodies.some((body) =>
            body.result?.content?.some((item) => item.text?.includes("second")),
          ),
        ).toBe(true);
        expect(bodies.every((body) => body.error === undefined)).toBe(true);
      }),
    30_000,
  );

  it.effect(
    "round-trips approval elicitation for a POST openapi operation",
    () =>
      Effect.gen(function* () {
        const { baseUrl, seedOrg } = yield* Worker;
        const { specJson } = yield* Upstream;
        const orgId = nextOrgId();
        yield* Effect.promise(() => seedOrg(orgId, "Elicit Org"));

        const client = yield* Effect.promise(() =>
          connectClient(baseUrl, makeTestBearer(nextAccountId(), orgId), {
            withElicitation: true,
          }),
        );

        let elicitCount = 0;
        client.setRequestHandler(ElicitRequestSchema, async () => {
          elicitCount++;
          return { action: "accept" as const, content: {} };
        });

        // User code inside `execute` (1) registers the upstream as an OpenAPI
        // source and (2) invokes its POST operation. `annotationsForOperation`
        // marks the POST as `requiresApproval: true`, which fires
        // `enforceApproval` in the executor; that goes through the MCP
        // elicitation handler and lands on `client.setRequestHandler` above.
        // Tool id is `<namespace>.<group>.<operation>` — Effect's
        // `HttpApiGroup` name ("approve") becomes part of the sandbox path,
        // so the invocation reads `tools.approveapi.approve.approveThing`.
        const code = [
          `await tools.executor.openapi.addSource({ scope: ${JSON.stringify(orgId)}, spec: ${JSON.stringify(specJson)}, namespace: "approveapi" });`,
          `return await tools.approveapi.approve.approveThing({});`,
        ].join("\n");
        const result = yield* Effect.promise(() =>
          client.callTool({ name: "execute", arguments: { code } }),
        );
        expect(result.isError).not.toBe(true);
        expect(elicitCount).toBeGreaterThan(0);
        const text =
          ((result.content ?? []) as Array<{ type: string; text?: string }>).find(
            (c) => c.type === "text",
          )?.text ?? "";
        expect(text).toContain("approved");

        yield* Effect.promise(() => client.close());
      }),
    30_000,
  );

  it.effect(
    "reports the McpSessionDO.handleRequest span via the OTLP exporter",
    () =>
      Effect.gen(function* () {
        const { baseUrl, seedOrg } = yield* Worker;
        const receiver = yield* TelemetryReceiver;
        const orgId = nextOrgId();
        yield* Effect.promise(() => seedOrg(orgId, "Telemetry Org"));
        const client = yield* Effect.promise(() =>
          connectClient(baseUrl, makeTestBearer(nextAccountId(), orgId)),
        );
        // Trigger the DO through a multi-step flow so we can assert that
        // handleRequest spans are reported for every DO hit, not just init.
        yield* Effect.promise(() => client.listTools());
        yield* Effect.promise(() =>
          client.callTool({ name: "execute", arguments: { code: "return 1 + 2" } }),
        );
        yield* Effect.promise(() => client.close());

        // The initialize POST carries no session-id; subsequent requests do.
        // Assert on one of the session-id'd handleRequest spans so we verify
        // attribute propagation beyond the degenerate init case.
        const handleSpan = yield* Effect.promise(() =>
          receiver.waitForSpan(
            (s) =>
              s.name === "McpSessionDO.handleRequest" &&
              s.attributes["mcp.request.session_id_present"] === true,
          ),
        );
        expect(handleSpan.attributes["mcp.request.method"]).toBeDefined();
        // 200 for normal POSTs, 202 for notifications/initialized.
        expect([200, 202]).toContain(handleSpan.attributes["mcp.response.status_code"]);
        expect(handleSpan.attributes["mcp.response.content_type"]).toEqual(expect.any(String));
        expect(handleSpan.attributes["mcp.transport.enable_json_response"]).toBe(true);

        // init runs once per new session and should appear on the initialize POST.
        yield* Effect.promise(() => receiver.waitForSpan((s) => s.name === "McpSessionDO.init"));
      }),
    30_000,
  );
});

layer(TestEnv, { timeout: 60_000 })("cloud MCP request-id telemetry", (it) => {
  it.effect(
    "exports MCP JSON-RPC request ids for request-shaped ids",
    () =>
      Effect.gen(function* () {
        const { baseUrl, seedOrg } = yield* Worker;
        const receiver = yield* TelemetryReceiver;
        const orgId = nextOrgId();
        const accountId = nextAccountId();
        const requestId = `req_${crypto.randomUUID().replace(/-/g, "")}`;
        yield* Effect.promise(() => seedOrg(orgId, "Request Id Org"));

        const response = yield* Effect.promise(() =>
          fetch(new URL("/mcp", baseUrl), {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${makeTestBearer(accountId, orgId)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: requestId,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "mcp-request-id-e2e", version: "0" },
              },
            }),
          }),
        );
        expect(response.status).toBe(200);
        yield* Effect.promise(() => response.text());

        const annotateSpan = yield* Effect.promise(() =>
          receiver.waitForSpan(
            (s) => s.name === "mcp.request.annotate" && s.attributes["mcp.rpc.id"] === requestId,
          ),
        );
        expect(annotateSpan.attributes["mcp.rpc.method"]).toBe("initialize");
      }),
    30_000,
  );
});
