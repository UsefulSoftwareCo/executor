/**
 * Tool commands and `executor mcp` as MCP clients of the resolved host's endpoint. The official MCP
 * SDK owns the Streamable HTTP protocol; this adapter supplies each request's bearer, refuses
 * redirects so credentials never follow them, and turns the SDK's failures into the CLI's typed
 * errors. Response bodies and credentials never enter an error.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type JSONRPCMessage,
  type JSONRPCRequest,
  McpError,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";
import { McpWhoami, mcpWhoamiPath } from "@executor-js/mcp-auth/grants";
import { Console, Effect, Exit, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import {
  AppClientError,
  HostRequestFailed,
  ToolCallRefused,
  ToolsSignInRequired,
  WhoamiUnavailable,
} from "../client-error.ts";
import type { ToolsTarget } from "./hosts.ts";

/**
 * How long a tool command waits for one MCP response. The host bounds a program at five minutes
 * and does not count time spent waiting for approval, so the CLI waits longer than that.
 */
const toolResponseTimeoutMs = 15 * 60_000;

/** The CLI's name and version as MCP clients see it. */
const clientInfo = {
  name: "executor-cli",
  version: process.env.EXECUTOR_BUILD_VERSION ?? "0.0.0-dev",
};

/**
 * `fetch` that sends the target's current bearer and refuses redirects. A credential that cannot
 * be resolved, such as a session whose refresh the host refused, is kept so the caller reports it
 * instead of the transport's generic failure.
 */
const authorizedFetch =
  <E>(target: ToolsTarget<E>, failures: Array<unknown>): FetchLike =>
  async (input, init) => {
    const token = await Effect.runPromiseExit(target.token);
    if (Exit.isFailure(token)) {
      failures.push(Option.getOrUndefined(Exit.findErrorOption(token)));
      throw new Error("The credential for this request could not be resolved.");
    }
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${Redacted.value(token.value)}`);
    return fetch(input, { ...init, headers, redirect: "error" });
  };

/**
 * The CLI's error for a failure the SDK raised: an unresolved credential first, then the host's
 * HTTP status, then a JSON-RPC error the endpoint answered, and otherwise no answer at all.
 */
const toolFailure =
  <E>(target: ToolsTarget<E>, tool: string, failures: ReadonlyArray<unknown>) =>
  (error: unknown) => {
    const credential = failures.find((failure) => failure !== undefined);
    if (credential !== undefined) return credential;
    const path = URL.parse(target.url)?.pathname ?? "/mcp";
    if (error instanceof StreamableHTTPError && error.code !== undefined && error.code > 0) {
      if (error.code === 401) return new ToolsSignInRequired({ host: target.host });
      if (error.code === 403) return new AppClientError({ reason: "forbidden" });
      return new HostRequestFailed({ reason: "status", method: "POST", path, status: error.code });
    }
    if (error instanceof StreamableHTTPError)
      return new HostRequestFailed({ reason: "response", method: "POST", path });
    if (error instanceof McpError)
      return new ToolCallRefused({
        tool,
        reason: "protocol",
        code: error.code,
        message: error.message.replace(/^MCP error -?\d+: /u, ""),
      });
    return new HostRequestFailed({ reason: "network", method: "POST", path });
  };

/** A text block of a tool result. */
const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const decodeText = Schema.decodeUnknownOption(TextBlock);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** An MCP session a command opened on the host, which a later command can continue. */
export const McpSession = Schema.Struct({ id: Schema.String, protocolVersion: Schema.String });
export type McpSession = typeof McpSession.Type;

/**
 * Call one of the host's MCP tools and return its result as JSON: its structured content, or the
 * JSON its first text block holds. A result the tool marks as an error fails with its text. With
 * `session`, the call continues that MCP session instead of opening one; either way the result
 * names the session it used.
 */
export const callTool = <E>(
  target: ToolsTarget<E>,
  tool: string,
  input: Record<string, unknown>,
  session?: McpSession,
) =>
  Effect.gen(function* () {
    const failures: Array<unknown> = [];
    const failed = toolFailure(target, tool, failures);
    const transport = new StreamableHTTPClientTransport(new URL(target.url), {
      fetch: authorizedFetch(target, failures),
      ...(session === undefined ? {} : { sessionId: session.id }),
    });
    // A continued session was initialized before, so the client sends no initialize.
    if (session !== undefined) transport.setProtocolVersion(session.protocolVersion);
    const client = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const client = new Client(clientInfo);
          // Hide the SDK getter that conflicts with its own exact-optional Transport type.
          const connected: Omit<StreamableHTTPClientTransport, "sessionId"> = transport;
          await client.connect(connected);
          return client;
        },
        catch: failed,
      }),
      (client) => Effect.promise(() => client.close()),
    );
    const result = yield* Effect.tryPromise({
      try: () =>
        client.callTool({ name: tool, arguments: input }, undefined, {
          timeout: toolResponseTimeoutMs,
        }),
      catch: failed,
    });
    const used =
      transport.sessionId === undefined || transport.protocolVersion === undefined
        ? Option.none<McpSession>()
        : Option.some({ id: transport.sessionId, protocolVersion: transport.protocolVersion });
    const texts = (Array.isArray(result.content) ? result.content : []).flatMap((block) =>
      Option.toArray(decodeText(block)).map(({ text }) => text),
    );
    if (result.isError === true)
      return yield* new ToolCallRefused({ tool, reason: "tool", message: texts.join("\n") });
    if (result.structuredContent !== undefined)
      return { value: result.structuredContent, session: used };
    const first = texts[0];
    const json = first === undefined ? Option.none() : decodeJson(first);
    if (Option.isNone(json))
      return yield* new HostRequestFailed({
        reason: "response",
        method: "POST",
        path: URL.parse(target.url)?.pathname ?? "/mcp",
      });
    return { value: json.value, session: used };
  }).pipe(Effect.scoped);

/** Print a tool's result as tool commands print every success: indented JSON on stdout. */
export const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

/**
 * What a whoami answer's access reaches, in words: every app, a connection's apps, or the tools of
 * apps selected on the grant after sign-in.
 */
export const describeAccess = (access: McpWhoami["access"]) => {
  const apps = (count: number) => `${count} ${count === 1 ? "app" : "apps"}`;
  switch (access.kind) {
    case "all":
      return "every app";
    case "connection":
      return `connection ${access.name} (${apps(access.apps)})`;
    case "tools":
      return `selected tools of ${apps(access.apps)}`;
  }
};

/**
 * Ask the host what the target's credential reaches. A host without the endpoint answers 404 and
 * fails as {@link WhoamiUnavailable}; any other answer outside the contract keeps its status.
 */
export const whoami = <E>(target: ToolsTarget<E>) =>
  Effect.gen(function* () {
    const url = new URL(mcpWhoamiPath, target.url);
    const token = yield* target.token;
    const response = yield* HttpClient.execute(
      HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(token)),
    ).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError(
        () => new HostRequestFailed({ reason: "network", method: "GET", path: url.pathname }),
      ),
    );
    if (response.status === 404) return yield* new WhoamiUnavailable({ host: target.host });
    if (response.status === 401) return yield* new ToolsSignInRequired({ host: target.host });
    if (response.status === 403) return yield* new AppClientError({ reason: "forbidden" });
    if (response.status !== 200)
      return yield* new HostRequestFailed({
        reason: "status",
        method: "GET",
        path: url.pathname,
        status: response.status,
      });
    return yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(McpWhoami)),
      Effect.mapError(
        () => new HostRequestFailed({ reason: "response", method: "GET", path: url.pathname }),
      ),
    );
  });

/** Appended to the host's own instructions in the relay's `initialize` result. */
export const relayInstructions =
  "The `executor` CLI is available in this shell and reaches these same tools: `executor search`, `describe`, `call`, `execute`, `resume` and `skills`. For a large result, prefer `executor call` or `executor execute` with its output redirected to a file, for example `executor execute --file program.js > result.json`, then read only the parts you need.";

const InitializeResult = Schema.Struct({
  protocolVersion: Schema.String,
  instructions: Schema.optional(Schema.String),
});

/** What a stdio client is told when the relay could not deliver its request. */
const relayRefusal = (failure: unknown) => {
  if (Schema.is(ToolsSignInRequired)(failure))
    return "Executor refused this CLI's sign-in. Run `executor login` in a terminal, then restart this MCP server.";
  if (Schema.is(AppClientError)(failure)) return "Executor refused this request (HTTP 403).";
  if (Schema.is(HostRequestFailed)(failure))
    return failure.status === undefined
      ? "Executor did not answer. Check that it is running and reachable, then retry."
      : `Executor answered HTTP ${failure.status}.`;
  return "Executor did not answer this request.";
};

/** Whether the host answered that it does not know the request's MCP session. */
const sessionForgotten = (error: unknown) =>
  error instanceof StreamableHTTPError && error.code === 404;

/**
 * How long the relay waits for the host to answer the `initialize` it sends to replace a forgotten
 * session: the MCP SDK's default request timeout.
 */
const reinitializeTimeoutMs = 60_000;

/** The relay could not open a new session after the host forgot its old one. */
class ReinitializeFailed extends Error {}

/**
 * `executor mcp`: a stdio MCP server that forwards every message both ways between its client and
 * the host's Streamable HTTP endpoint, including requests the host starts, such as elicitation,
 * and the client's answers to them. Each request carries the target's current bearer. The relay
 * runs until its client closes standard input.
 *
 * A stdio client has no MCP session of its own, so the relay owns the host's. When the host
 * answers a request with 404 for that session, as after it restarts, the relay opens a new one
 * with the `initialize` parameters its client sent and sends the request again, once. Requests
 * the host started in the forgotten session, and answers still due on it, are lost with it.
 */
export const relay = <E>(target: ToolsTarget<E>) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<never>();
    const report = (message: string) => Effect.runForkWith(services)(Console.error(message));
    const failures: Array<unknown> = [];
    const open = () =>
      new StreamableHTTPClientTransport(new URL(target.url), {
        fetch: authorizedFetch(target, failures),
      });
    /** The transport of the host session in use; replaced when the host forgets it. */
    let upstream = open();
    yield* Effect.addFinalizer(() => Effect.promise(() => upstream.close()));
    const downstream = yield* Effect.acquireRelease(
      Effect.sync(() => new StdioServerTransport()),
      (transport) => Effect.promise(() => transport.close()),
    );
    yield* Effect.callback<void>((resume) => {
      /** Requests whose answer is an `initialize` result, which carries the instructions. */
      const initializing = new Set<string | number>();
      /** The client's own `initialize`, which a replacement session repeats. */
      let initialize: JSONRPCRequest | undefined;
      /** Answers to the relay's own `initialize` requests, by their IDs. */
      const reinitializing = new Map<string, (message: JSONRPCMessage) => void>();
      let reinitializations = 0;
      /** The replacement session being opened, which every request that hit 404 waits for. */
      let reopening: Promise<void> | undefined;

      const wire = (transport: StreamableHTTPClientTransport) => {
        transport.onmessage = (message) => {
          if (
            (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
            typeof message.id === "string"
          ) {
            const answer = reinitializing.get(message.id);
            if (answer !== undefined) return answer(message);
          }
          let forwarded: JSONRPCMessage = message;
          if (isJSONRPCResultResponse(message) && initializing.delete(message.id)) {
            const initialized = Schema.decodeUnknownOption(InitializeResult)(message.result);
            if (Option.isSome(initialized)) {
              transport.setProtocolVersion(initialized.value.protocolVersion);
              const instructions = initialized.value.instructions;
              forwarded = {
                ...message,
                result: {
                  ...message.result,
                  instructions:
                    instructions === undefined || instructions === ""
                      ? relayInstructions
                      : `${instructions}\n\n${relayInstructions}`,
                },
              };
            }
          }
          downstream.send(forwarded).catch(() => resume(Effect.void));
        };
        transport.onerror = (error) => {
          // A forgotten session is replaced on the next request; a replaced transport is done.
          if (transport !== upstream || sessionForgotten(error)) return;
          // Read, not taken: a failed send also rejects, and its caller reports the credential.
          report(
            `executor mcp: ${relayRefusal(toolFailure(target, "relay", failures.slice())(error))}`,
          );
        };
      };

      /** Open a session in place of `lost`, with the client's `initialize`, unless one already is. */
      const reopen = (lost: StreamableHTTPClientTransport, original: JSONRPCRequest) => {
        if (upstream !== lost) return Promise.resolve();
        reopening ??= (async () => {
          const fresh = open();
          wire(fresh);
          await fresh.start();
          const id = `executor-mcp-relay-initialize-${++reinitializations}`;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const answered = new Promise<JSONRPCMessage>((resolve, reject) => {
            reinitializing.set(id, resolve);
            timer = setTimeout(
              () => reject(new ReinitializeFailed("The host did not answer initialize.")),
              reinitializeTimeoutMs,
            );
          });
          try {
            await fresh.send({ ...original, id });
            const answer = await answered;
            const initialized = isJSONRPCResultResponse(answer)
              ? Schema.decodeUnknownOption(InitializeResult)(answer.result)
              : Option.none();
            if (Option.isNone(initialized))
              throw new ReinitializeFailed("The host refused initialize.");
            fresh.setProtocolVersion(initialized.value.protocolVersion);
            await fresh.send({ jsonrpc: "2.0", method: "notifications/initialized" });
          } catch (error) {
            await fresh.close();
            throw error;
          } finally {
            clearTimeout(timer);
            reinitializing.delete(id);
          }
          upstream = fresh;
          await lost.close();
        })().finally(() => {
          reopening = undefined;
        });
        return reopening;
      };

      /**
       * Send `message` on the current session. A request the host refuses because it forgot the
       * session is sent again, once, on a new one.
       */
      const forward = async (message: JSONRPCMessage) => {
        const via = upstream;
        try {
          await via.send(message);
        } catch (error) {
          const original = initialize;
          if (
            !sessionForgotten(error) ||
            via.sessionId === undefined ||
            original === undefined ||
            !isJSONRPCRequest(message) ||
            message.method === "initialize"
          )
            throw error;
          failures.splice(0);
          await reopen(via, original);
          await upstream.send(message);
        }
      };

      wire(upstream);
      downstream.onmessage = (message) => {
        if (isJSONRPCRequest(message) && message.method === "initialize") {
          initializing.add(message.id);
          initialize = message;
        }
        forward(message).catch((error: unknown) => {
          const refusal =
            error instanceof ReinitializeFailed
              ? `Executor no longer knows this MCP session, and opening a new one failed: ${error.message}`
              : relayRefusal(toolFailure(target, "relay", failures.splice(0))(error));
          if (!isJSONRPCRequest(message)) {
            report(`executor mcp: ${refusal}`);
            return;
          }
          initializing.delete(message.id);
          return downstream.send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: refusal },
          });
        });
      };
      downstream.onerror = () => resume(Effect.void);
      downstream.onclose = () => resume(Effect.void);
      // The SDK's stdio transport stops reading at the end of input but does not close itself.
      process.stdin.once("end", () => resume(Effect.void));
      upstream
        .start()
        .then(() => downstream.start())
        .catch(() => resume(Effect.void));
    });
  }).pipe(Effect.scoped);
