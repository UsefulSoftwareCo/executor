// ---------------------------------------------------------------------------
// Codex app-server bridge transport — loaded only on demand
//
// Since the 2026-08-28 Codex update, the service behind the curated Codex
// plugins (Messages / Computer Use / Computer History) only honours tool
// calls from a session registered by a Codex host process: spawning the
// plugin's stdio MCP client directly still lists tools, but every call hangs
// or fails with "Sender process is not authenticated". The supported path to
// a working call is `codex app-server` — Codex's own JSON-RPC front end —
// whose `mcpServer/tool/call` invokes a plugin tool directly, with no model
// turn and no inference.
//
// This module bridges that protocol gap IN PROCESS: it presents the MCP SDK's
// `Transport` interface upstream (so the ordinary `Client`, discovery, invoke
// and elicitation paths work unchanged) while speaking the app-server
// protocol to a spawned `codex app-server` child downstream:
//
//   MCP upstream                      app-server downstream
//   initialize                    →   initialize → initialized → thread/start
//   tools/list                    →   mcpServerStatus/list (one server's tools)
//   tools/call                    →   mcpServer/tool/call
//   elicitation/create (to client) ←  mcpServer/elicitation/request
//
// The downstream wire is newline-delimited JSON managed HERE, not the SDK's
// `StdioClientTransport`: that transport validates every incoming line
// against the MCP message schemas, and real app-server traffic is not
// MCP-shaped (`_meta: null`, `turnId: null`, its own notification families),
// so the SDK transport silently drops it. The child environment follows the
// same rules as an SDK spawn via `stdioSpawnEnv`.
//
// Kept out of `connection.ts`'s eager imports for the same reason as
// `stdio-connector.ts`: it evaluates `node:child_process` at module load,
// which crashes workerd at instantiation. Callers reach it via a dynamic
// import in the appserver branch of `createMcpConnector`.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from "node:child_process";

import type { JSONRPCMessage, JSONRPCRequest, Transport } from "@modelcontextprotocol/client";
import { Option, Schema } from "effect";

import { stdioSpawnEnv, type StdioTransportConfig } from "./stdio-connector";

export type AppServerTransportConfig = StdioTransportConfig & {
  /** The MCP server name inside Codex whose tools this transport exposes
   *  (e.g. `messages`) — the `server` of every `mcpServer/tool/call`. */
  readonly server: string;
};

// ---------------------------------------------------------------------------
// Downstream (app-server) payload shapes — only the fields the bridge reads.
// Lenient on purpose: an unexpected shape fails one call, never the process.
// ---------------------------------------------------------------------------

const decodeDownstreamMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Unknown),
      result: Schema.optional(Schema.Unknown),
      error: Schema.optional(Schema.Unknown),
    }),
  ),
);

const decodeInitializeParams = Schema.decodeUnknownOption(
  Schema.Struct({ protocolVersion: Schema.optional(Schema.String) }),
);

const decodeToolsCallParams = Schema.decodeUnknownOption(
  Schema.Struct({ name: Schema.String, arguments: Schema.optional(Schema.Unknown) }),
);

const decodeThreadStartResult = Schema.decodeUnknownOption(
  Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) }),
);

const decodeServerStatusList = Schema.decodeUnknownOption(
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        tools: Schema.optional(
          Schema.NullOr(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))),
        ),
      }),
    ),
    nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

const decodeToolCallResult = Schema.decodeUnknownOption(
  Schema.Struct({
    content: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
    structuredContent: Schema.optional(Schema.Unknown),
    isError: Schema.optional(Schema.NullOr(Schema.Boolean)),
  }),
);

const decodeElicitationParams = Schema.decodeUnknownOption(
  Schema.Struct({
    mode: Schema.optional(Schema.NullOr(Schema.String)),
    message: Schema.optional(Schema.NullOr(Schema.String)),
    requestedSchema: Schema.optional(Schema.Unknown),
    url: Schema.optional(Schema.NullOr(Schema.String)),
    elicitationId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

const decodeElicitResult = Schema.decodeUnknownOption(
  Schema.Struct({
    action: Schema.Literals(["accept", "decline", "cancel"]),
    content: Schema.optional(Schema.Unknown),
  }),
);

const decodeRpcError = Schema.decodeUnknownOption(
  Schema.Struct({
    code: Schema.optional(Schema.NullOr(Schema.Number)),
    message: Schema.optional(Schema.NullOr(Schema.String)),
    data: Schema.optional(Schema.Unknown),
  }),
);

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

type RpcError = { readonly code: number; readonly message: string; readonly data?: unknown };

type AppServerReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: RpcError };

const INTERNAL_ERROR = -32603;
const METHOD_NOT_FOUND = -32601;

const CHANNEL_CLOSED: AppServerReply = {
  ok: false,
  error: { code: INTERNAL_ERROR, message: "Codex app-server exited before replying" },
};

class AppServerClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  readonly #config: AppServerTransportConfig;
  #child: ChildProcess | undefined;
  #stdoutBuffer = "";
  #threadId: string | undefined;
  #nextDownstreamId = 1;
  #nextElicitationId = 1;
  readonly #pending = new Map<number, (reply: AppServerReply) => void>();
  /** Upstream `elicitation/create` request id → downstream app-server id. */
  readonly #elicitations = new Map<string, string | number>();

  constructor(config: AppServerTransportConfig) {
    this.#config = config;
  }

  async start(): Promise<void> {
    const child = spawn(this.#config.command, [...(this.#config.args ?? [])], {
      cwd: this.#config.cwd,
      env: stdioSpawnEnv(this.#config.env),
      // The app-server logs to stderr; none of it is protocol traffic.
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.#child = child;
    // Stream errors (EPIPE against a dead child above all) must never become
    // process-fatal `error` events; the exit handler owns the cleanup.
    child.stdin?.on("error", () => undefined);
    child.stdout?.on("error", () => undefined);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#onStdout(chunk));
    child.on("error", (error) => {
      this.onerror?.(error);
      this.#teardown();
    });
    child.on("exit", () => this.#teardown());
    await Promise.resolve();
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    child.stdin?.end();
    child.kill("SIGTERM");
    // The real binary exits on SIGTERM; the escalation only guards a wedged
    // child, and unref'd so it never holds the host process open.
    const escalate = setTimeout(() => child.kill("SIGKILL"), 3000);
    escalate.unref();
    await Promise.resolve();
  }

  #teardown(): void {
    if (this.#child === undefined) return;
    this.#child = undefined;
    for (const settle of this.#pending.values()) settle(CHANNEL_CLOSED);
    this.#pending.clear();
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!("method" in message)) {
      // A response from the client — the only server→client requests the
      // bridge forwards are elicitations, so route it back to the app-server.
      this.#completeElicitation(message);
      return;
    }
    if (!("id" in message)) {
      // Client notifications (`notifications/initialized`, cancellations)
      // have no app-server counterpart on this bridge; the downstream
      // `initialized` is sent by the handshake itself.
      return;
    }
    if (message.method === "initialize") {
      await this.#handleInitialize(message);
      return;
    }
    if (message.method === "tools/list") {
      await this.#handleToolsList(message);
      return;
    }
    if (message.method === "tools/call") {
      await this.#handleToolsCall(message);
      return;
    }
    if (message.method === "ping") {
      this.#emit({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    this.#emit({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: METHOD_NOT_FOUND,
        message: `The Codex app-server bridge does not support ${message.method}`,
      },
    });
  }

  /** Deliver a synthesized message to the MCP client. */
  #emit(message: unknown): void {
    this.onmessage?.(message as JSONRPCMessage);
  }

  #fail(id: JSONRPCRequest["id"], error: RpcError): void {
    this.#emit({ jsonrpc: "2.0", id, error });
  }

  /** Write one message to the app-server. Best-effort: a write racing the
   *  child's exit is settled by the exit handler, not the write. */
  #sendDownstream(message: unknown): void {
    this.#child?.stdin?.write(`${JSON.stringify(message)}\n`, () => undefined);
  }

  /** One app-server request/response round trip. Never rejects: transport
   *  failures resolve as an error reply so every caller maps them onto the
   *  one upstream request it is serving. */
  #request(method: string, params: unknown): Promise<AppServerReply> {
    if (this.#child === undefined) return Promise.resolve(CHANNEL_CLOSED);
    const id = this.#nextDownstreamId++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#sendDownstream({ jsonrpc: "2.0", id, method, params });
    });
  }

  async #handleInitialize(message: JSONRPCRequest): Promise<void> {
    const init = await this.#request("initialize", {
      clientInfo: { name: "executor-mcp", title: "Executor", version: "0.1.0" },
    });
    if (!init.ok) {
      this.#fail(message.id, init.error);
      return;
    }
    this.#sendDownstream({ jsonrpc: "2.0", method: "initialized" });
    const started = await this.#request("thread/start", { sessionStartSource: "startup" });
    if (!started.ok) {
      this.#fail(message.id, started.error);
      return;
    }
    const thread = decodeThreadStartResult(started.result);
    if (Option.isNone(thread)) {
      this.#fail(message.id, {
        code: INTERNAL_ERROR,
        message: "Codex app-server returned an unexpected thread/start result",
      });
      return;
    }
    this.#threadId = thread.value.thread.id;
    // Echo the client's offered protocol version: the bridge itself has no
    // version constraint, and echoing keeps the SDK's own support check green.
    const params = decodeInitializeParams(message.params);
    const protocolVersion = Option.getOrUndefined(params)?.protocolVersion ?? "2025-06-18";
    this.#emit({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: this.#config.server,
          title: `Codex plugin server "${this.#config.server}"`,
          version: "0.1.0",
        },
      },
    });
  }

  async #handleToolsList(message: JSONRPCRequest): Promise<void> {
    const tools = await this.#collectServerTools(message.id);
    if (tools === undefined) return;
    this.#emit({ jsonrpc: "2.0", id: message.id, result: { tools } });
  }

  /** The bridged server's tool definitions from `mcpServerStatus/list`,
   *  following pagination until the server is found. Emits the failure and
   *  returns undefined when the server is absent or a page is malformed. */
  async #collectServerTools(
    requestId: JSONRPCRequest["id"],
  ): Promise<readonly Record<string, unknown>[] | undefined> {
    let cursor: string | undefined;
    // Bounded so a pathological pager cannot spin the bridge forever.
    for (let page = 0; page < 16; page++) {
      const reply = await this.#request("mcpServerStatus/list", {
        threadId: this.#threadId,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!reply.ok) {
        this.#fail(requestId, reply.error);
        return undefined;
      }
      const decoded = decodeServerStatusList(reply.result);
      if (Option.isNone(decoded)) {
        this.#fail(requestId, {
          code: INTERNAL_ERROR,
          message: "Codex app-server returned an unexpected mcpServerStatus/list result",
        });
        return undefined;
      }
      const server = decoded.value.data.find((entry) => entry.name === this.#config.server);
      if (server !== undefined) {
        // The map values are already MCP-wire tools; the key is authoritative
        // for the name either way.
        return Object.entries(server.tools ?? {}).map(([name, tool]) => ({ ...tool, name }));
      }
      cursor = decoded.value.nextCursor ?? undefined;
      if (cursor === undefined) break;
    }
    this.#fail(requestId, {
      code: INTERNAL_ERROR,
      message: `Codex does not report an MCP server named "${this.#config.server}". Its plugin may be uninstalled or disabled in Codex.`,
    });
    return undefined;
  }

  async #handleToolsCall(message: JSONRPCRequest): Promise<void> {
    const params = decodeToolsCallParams(message.params);
    if (Option.isNone(params)) {
      this.#fail(message.id, { code: INTERNAL_ERROR, message: "Malformed tools/call params" });
      return;
    }
    const reply = await this.#request("mcpServer/tool/call", {
      threadId: this.#threadId,
      server: this.#config.server,
      tool: params.value.name,
      arguments: params.value.arguments ?? {},
    });
    if (!reply.ok) {
      this.#fail(message.id, reply.error);
      return;
    }
    const result = decodeToolCallResult(reply.result);
    if (Option.isNone(result)) {
      this.#fail(message.id, {
        code: INTERNAL_ERROR,
        message: "Codex app-server returned an unexpected mcpServer/tool/call result",
      });
      return;
    }
    this.#emit({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: result.value.content ?? [],
        ...(result.value.structuredContent === undefined || result.value.structuredContent === null
          ? {}
          : { structuredContent: result.value.structuredContent }),
        ...(result.value.isError === true ? { isError: true } : {}),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Downstream traffic
  // -------------------------------------------------------------------------

  #onStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    const lines = this.#stdoutBuffer.split("\n");
    this.#stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const decoded = decodeDownstreamMessage(trimmed);
      if (Option.isSome(decoded)) this.#handleDownstream(decoded.value);
    }
  }

  #handleDownstream(message: {
    readonly id?: number | string;
    readonly method?: string;
    readonly params?: unknown;
    readonly result?: unknown;
    readonly error?: unknown;
  }): void {
    if (message.method === undefined) {
      // Response to one of the bridge's own requests.
      if (typeof message.id !== "number") return;
      const settle = this.#pending.get(message.id);
      if (settle === undefined) return;
      this.#pending.delete(message.id);
      if (message.error === undefined) {
        settle({ ok: true, result: message.result });
        return;
      }
      const rpcFailure = Option.getOrUndefined(decodeRpcError(message.error));
      settle({
        ok: false,
        error: {
          code: rpcFailure?.code ?? INTERNAL_ERROR,
          message: rpcFailure?.message ?? "Codex app-server request failed",
          ...(rpcFailure?.data === undefined ? {} : { data: rpcFailure.data }),
        },
      });
      return;
    }
    if (message.id === undefined) return; // App-server notifications carry no work for the bridge.
    if (message.method === "mcpServer/elicitation/request") {
      this.#forwardElicitation(message.id, message.params);
      return;
    }
    // Any other server-initiated request (turn approvals never happen — the
    // bridge starts no turns) is refused so the app-server does not wait.
    this.#sendDownstream({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: METHOD_NOT_FOUND,
        message: `The Codex app-server bridge does not handle ${message.method}`,
      },
    });
  }

  /** An approval prompt from the plugin, surfaced through Codex — re-emitted
   *  upstream as a standard MCP `elicitation/create` so executor's existing
   *  elicitation bridge (native / browser / model) answers it. */
  #forwardElicitation(downstreamId: string | number, rawParams: unknown): void {
    const params = Option.getOrUndefined(decodeElicitationParams(rawParams));
    const upstreamId = `codex-elicitation-${this.#nextElicitationId++}`;
    this.#elicitations.set(upstreamId, downstreamId);
    const prompt = params?.message ?? `Approve this Codex "${this.#config.server}" request?`;
    const upstreamParams =
      params?.mode === "url" && params.url != null && params.elicitationId != null
        ? { mode: "url", message: prompt, url: params.url, elicitationId: params.elicitationId }
        : {
            message: prompt,
            // `openai/form` schemas pass through verbatim — the form renderer
            // shows what it understands, and a decline stays safe.
            requestedSchema: params?.requestedSchema ?? { type: "object", properties: {} },
          };
    this.#emit({
      jsonrpc: "2.0",
      id: upstreamId,
      method: "elicitation/create",
      params: upstreamParams,
    });
  }

  #completeElicitation(message: JSONRPCMessage): void {
    if (!("id" in message) || message.id === null) return;
    const downstreamId = this.#elicitations.get(String(message.id));
    if (downstreamId === undefined) return;
    this.#elicitations.delete(String(message.id));
    const decoded =
      "result" in message ? Option.getOrUndefined(decodeElicitResult(message.result)) : undefined;
    // An error or unreadable answer cancels: never fabricate an approval.
    const result =
      decoded === undefined
        ? { action: "cancel" }
        : {
            action: decoded.action,
            ...(decoded.content === undefined ? {} : { content: decoded.content }),
          };
    this.#sendDownstream({ jsonrpc: "2.0", id: downstreamId, result });
  }
}

export const createAppServerTransport = (config: AppServerTransportConfig): Transport =>
  new AppServerClientTransport(config);
