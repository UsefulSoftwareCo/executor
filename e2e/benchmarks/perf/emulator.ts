/**
 * Synthetic upstreams for performance runs: an MCP server and an OpenAPI service whose size and
 * timing come from the URL path, so the same Worker or loopback process serves every shape.
 *
 *   /mcp/<spec>/mcp                Streamable HTTP MCP endpoint (stateless JSON responses)
 *   /openapi/<spec>/openapi.json   OpenAPI 3.0 document; operations live under /openapi/<spec>/ops
 *
 * `<spec>` is a hyphen-separated list of letter+number settings (all optional):
 *   t tool count (10)   l per-call latency ms (0)   j uniform jitter ms (0)
 *   s latency of every tools/list or document read ms (0)
 *   c extra first-load delay per isolate and spec ms (0)   e call error rate per mille (0)
 *   a require an `x-api-key` header when 1 (0)            k free-form instance key
 * Example: /mcp/t200-l40-j10-s800-c2500-e0-a1-kalpha/mcp
 *
 * Every response reports the emulator's own processing time in `x-emulator-processing-ms` and
 * `Server-Timing: emulator;dur=<ms>`. Tool results repeat it in their body as `emulator.processingMs`
 * so an Executor execution can report upstream time without response header access.
 * Data is generated; nothing is derived from customer content.
 */
import { Clock, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

export interface EmulatorSpec {
  readonly tools: number;
  readonly latencyMs: number;
  readonly jitterMs: number;
  readonly listMs: number;
  readonly coldMs: number;
  readonly errorPerMille: number;
  readonly auth: boolean;
  readonly key: string;
}

const defaults: EmulatorSpec = {
  tools: 10,
  latencyMs: 0,
  jitterMs: 0,
  listMs: 0,
  coldMs: 0,
  errorPerMille: 0,
  auth: false,
  key: "default",
};

/** Parse the path segment; unknown or oversized settings are rejected instead of clamped. */
export const parseSpec = (segment: string): Option.Option<EmulatorSpec> => {
  let spec = defaults;
  for (const part of segment.split("-")) {
    if (part === "") continue;
    const letter = part[0],
      rest = part.slice(1);
    if (letter === "k") {
      if (!/^[a-z0-9]{1,40}$/.test(rest)) return Option.none();
      spec = { ...spec, key: rest };
      continue;
    }
    if (!/^\d{1,6}$/.test(rest)) return Option.none();
    const value = Number(rest);
    if (letter === "t" && value >= 1 && value <= 20000) spec = { ...spec, tools: value };
    else if (letter === "l" && value <= 120000) spec = { ...spec, latencyMs: value };
    else if (letter === "j" && value <= 60000) spec = { ...spec, jitterMs: value };
    else if (letter === "s" && value <= 120000) spec = { ...spec, listMs: value };
    else if (letter === "c" && value <= 120000) spec = { ...spec, coldMs: value };
    else if (letter === "e" && value <= 1000) spec = { ...spec, errorPerMille: value };
    else if (letter === "a" && value <= 1) spec = { ...spec, auth: value === 1 };
    else return Option.none();
  }
  return Option.some(spec);
};

/** Render a spec back to its canonical path segment. */
export const formatSpec = (spec: Partial<EmulatorSpec>) => {
  const value = { ...defaults, ...spec };
  return [
    `t${value.tools}`,
    `l${value.latencyMs}`,
    `j${value.jitterMs}`,
    `s${value.listMs}`,
    `c${value.coldMs}`,
    `e${value.errorPerMille}`,
    `a${value.auth ? 1 : 0}`,
    `k${value.key}`,
  ].join("-");
};

// Deterministic tool shapes: names, descriptions and schemas depend only on the index.
const words = [
  "account",
  "record",
  "invoice",
  "project",
  "ticket",
  "message",
  "channel",
  "document",
  "report",
  "event",
  "customer",
  "order",
  "shipment",
  "dataset",
  "workflow",
  "comment",
];
const verbs = ["list", "get", "create", "update", "search", "archive", "export", "sync"];
const toolName = (index: number) =>
  `${verbs[index % verbs.length]}_${words[Math.floor(index / verbs.length) % words.length]}_${String(index).padStart(4, "0")}`;
const describe = (index: number) =>
  `${verbs[index % verbs.length]} ${words[Math.floor(index / verbs.length) % words.length]} items in the synthetic workspace. ` +
  `Supports filtering, pagination and field selection. Generated operation ${index} for performance tests.`;
const properties = (index: number) => {
  const count = 2 + (index % 5);
  const entries: Record<string, unknown> = {};
  for (let field = 0; field < count; field++) {
    const kind = (index + field) % 4;
    entries[`${words[(index + field) % words.length]}_${field}`] =
      kind === 0
        ? { type: "string", description: `Filter by ${words[field % words.length]}` }
        : kind === 1
          ? { type: "integer", minimum: 0, maximum: 1000, description: "Page size" }
          : kind === 2
            ? { type: "boolean", description: "Include archived items" }
            : { type: "string", enum: ["asc", "desc"], description: "Sort order" };
  }
  return entries;
};

const coldSeen = new Set<string>();

interface Outcome {
  readonly status: number;
  readonly body?: unknown;
  readonly text?: string;
  readonly contentType?: string;
}

const sleep = (ms: number) => (ms > 0 ? Effect.sleep(`${Math.round(ms)} millis`) : Effect.void);
const jittered = (spec: EmulatorSpec) =>
  Math.max(0, spec.latencyMs + (Math.random() * 2 - 1) * spec.jitterMs);
const firstLoad = (kind: string, spec: EmulatorSpec) =>
  Effect.suspend(() => {
    const id = `${kind}:${formatSpec(spec)}`;
    if (coldSeen.has(id)) return sleep(spec.listMs);
    coldSeen.add(id);
    return sleep(spec.listMs + spec.coldMs);
  });
const failed = (spec: EmulatorSpec) => Math.random() * 1000 < spec.errorPerMille;

const Rpc = Schema.Struct({
  jsonrpc: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.String,
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const mcp = (spec: EmulatorSpec, method: string, raw: string) =>
  Effect.gen(function* () {
    if (method === "GET") return { status: 405, text: "" } satisfies Outcome;
    if (method === "DELETE") return { status: 204 } satisfies Outcome;
    if (method !== "POST") return { status: 405, text: "" } satisfies Outcome;
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Rpc))(raw);
    if (Option.isNone(decoded)) return { status: 400, body: { error: "invalid JSON-RPC" } };
    const message = decoded.value;
    if (message.id === undefined) return { status: 202 } satisfies Outcome;
    const reply = (result: unknown) => ({
      status: 200,
      body: { jsonrpc: "2.0", id: message.id, result },
    });
    if (message.method === "initialize") {
      const requested = message.params?.protocolVersion;
      return reply({
        protocolVersion: typeof requested === "string" ? requested : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "Perf emulator", version: "1" },
      });
    }
    if (message.method === "ping") return reply({});
    if (message.method === "tools/list") {
      yield* firstLoad("mcp", spec);
      return reply({
        tools: Array.from({ length: spec.tools }, (_, index) => ({
          name: toolName(index),
          description: describe(index),
          inputSchema: { type: "object", properties: properties(index) },
          annotations: { readOnlyHint: index % 4 !== 2 },
        })),
      });
    }
    if (message.method === "tools/call") {
      const started = yield* Clock.currentTimeMillis;
      yield* sleep(jittered(spec));
      const processingMs = (yield* Clock.currentTimeMillis) - started;
      const name = message.params?.name;
      if (failed(spec))
        return reply({
          content: [{ type: "text", text: "Synthetic upstream failure" }],
          isError: true,
          structuredContent: { emulator: { processingMs, key: spec.key, failed: true } },
        });
      const value = {
        tool: typeof name === "string" ? name : null,
        arguments: message.params?.arguments ?? {},
        emulator: { processingMs, key: spec.key },
      };
      return reply({
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
        isError: false,
      });
    }
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      },
    };
  });

const openapiDocument = (spec: EmulatorSpec, base: string) => ({
  openapi: "3.0.3",
  info: { title: `Perf emulator ${spec.key}`, version: "1" },
  servers: [{ url: base }],
  ...(spec.auth
    ? {
        components: {
          securitySchemes: { key: { type: "apiKey", in: "header", name: "x-api-key" } },
        },
        security: [{ key: [] }],
      }
    : {}),
  paths: Object.fromEntries(
    Array.from({ length: spec.tools }, (_, index) => {
      const write = index % 4 === 2;
      const name = toolName(index);
      const operation = {
        operationId: name,
        summary: describe(index).slice(0, 60),
        description: describe(index),
        ...(write
          ? {
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: { type: "object", properties: properties(index) },
                  },
                },
              },
            }
          : {
              parameters: Object.keys(properties(index)).map((field) => ({
                name: field,
                in: "query",
                required: false,
                schema: { type: "string" },
              })),
            }),
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      };
      return [`/ops/${name}`, write ? { post: operation } : { get: operation }];
    }),
  ),
});

const openapi = (spec: EmulatorSpec, method: string, rest: string, base: string) =>
  Effect.gen(function* () {
    if (rest === "openapi.json" && method === "GET") {
      yield* firstLoad("openapi", spec);
      return { status: 200, body: openapiDocument(spec, base) } satisfies Outcome;
    }
    const operation = /^ops\/([a-z_0-9]+)$/.exec(rest)?.[1];
    if (operation === undefined) return { status: 404, body: { error: "not found" } };
    const started = yield* Clock.currentTimeMillis;
    yield* sleep(jittered(spec));
    const processingMs = (yield* Clock.currentTimeMillis) - started;
    if (failed(spec))
      return {
        status: 503,
        body: { error: "Synthetic upstream failure", emulator: { processingMs, key: spec.key } },
      };
    return {
      status: 200,
      body: { tool: operation, ok: true, emulator: { processingMs, key: spec.key } },
    } satisfies Outcome;
  });

/** Route one request. The public origin comes from the Host header, so servers[] stays absolute. */
export const emulatorResponse = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const started = yield* Clock.currentTimeMillis;
  const host = request.headers.host ?? "127.0.0.1";
  const protocol =
    request.headers["x-forwarded-proto"] ??
    (/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) ? "http" : "https");
  // Web handlers keep the absolute URL; Node servers supply only the path and Host header.
  const url = URL.parse(request.originalUrl) ?? new URL(request.url, `${protocol}://${host}`);
  const match = /^\/(mcp|openapi)\/([a-z0-9-]+)\/(.*)$/.exec(url.pathname);
  let outcome: Outcome;
  if (url.pathname === "/" || url.pathname === "/health")
    outcome = { status: 200, body: { status: "ok", service: "perf-emulator" } };
  else if (match === null) outcome = { status: 404, body: { error: "not found" } };
  else {
    const [, kind = "", segment = "", rest = ""] = match;
    const spec = parseSpec(segment);
    if (Option.isNone(spec)) outcome = { status: 400, body: { error: "invalid emulator spec" } };
    else if (spec.value.auth && !request.headers["x-api-key"])
      outcome = { status: 401, body: { error: "missing x-api-key" } };
    else {
      const raw = request.method === "POST" ? yield* request.text : "";
      outcome =
        kind === "mcp"
          ? rest === "mcp"
            ? yield* mcp(spec.value, request.method, raw)
            : { status: 404, body: { error: "not found" } }
          : yield* openapi(spec.value, request.method, rest, `${url.origin}/openapi/${segment}`);
    }
  }
  const processing = (yield* Clock.currentTimeMillis) - started;
  const headers = {
    "cache-control": "no-store",
    "x-emulator-processing-ms": String(processing),
    "server-timing": `emulator;dur=${processing}`,
  };
  if (outcome.body !== undefined)
    return HttpServerResponse.jsonUnsafe(outcome.body, { status: outcome.status, headers });
  if (outcome.text !== undefined)
    return HttpServerResponse.text(outcome.text, { status: outcome.status, headers });
  return HttpServerResponse.empty({ status: outcome.status, headers });
}).pipe(
  Effect.catchCause(() =>
    Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "emulator failure" }, { status: 500 })),
  ),
);

/** One catch-all route shared by the Worker entry and the loopback server. */
export const emulatorRoutes = Layer.mergeAll(
  HttpRouter.add("*", "*", emulatorResponse),
  HttpRouter.add("*", "/", emulatorResponse),
);
