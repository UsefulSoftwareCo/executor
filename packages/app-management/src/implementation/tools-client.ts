import {
  InsufficientScopeError,
  SdkError,
  SdkHttpError,
  StreamableHTTPClientTransport as RelayUpstreamTransport,
} from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type JSONRPCErrorResponse,
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

const toolResponseTimeoutMs = 15 * 60_000;

const clientInfo = {
  name: "executor-cli",
  version: process.env.EXECUTOR_BUILD_VERSION ?? "0.0.0-dev",
};

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

const httpStatus = (error: unknown) => {
  if (error instanceof StreamableHTTPError) return error.code;
  if (error instanceof SdkHttpError) return error.status;
  if (error instanceof InsufficientScopeError) return 403;
  return undefined;
};

const toolFailure =
  <E>(target: ToolsTarget<E>, tool: string, failures: ReadonlyArray<unknown>) =>
  (error: unknown) => {
    const credential = failures.find((failure) => failure !== undefined);
    if (credential !== undefined) return credential;
    const path = URL.parse(target.url)?.pathname ?? "/mcp";
    const status = httpStatus(error);
    if (status !== undefined && status > 0) {
      if (status === 401) return new ToolsSignInRequired({ host: target.host });
      if (status === 403) return new AppClientError({ reason: "forbidden" });
      return new HostRequestFailed({ reason: "status", method: "POST", path, status });
    }
    if (error instanceof StreamableHTTPError || error instanceof SdkError)
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

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const decodeText = Schema.decodeUnknownOption(TextBlock);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

export const McpSession = Schema.Struct({ id: Schema.String, protocolVersion: Schema.String });
export type McpSession = typeof McpSession.Type;

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
    if (session !== undefined) transport.setProtocolVersion(session.protocolVersion);
    const client = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const client = new Client(clientInfo);
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
    const content: ReadonlyArray<unknown> = Array.isArray(result.content) ? result.content : [];
    if (result.structuredContent !== undefined)
      return { value: result.structuredContent, content, session: used };
    const first = texts[0];
    const json = first === undefined ? Option.none() : decodeJson(first);
    if (Option.isNone(json))
      return yield* new HostRequestFailed({
        reason: "response",
        method: "POST",
        path: URL.parse(target.url)?.pathname ?? "/mcp",
      });
    return { value: json.value, content, session: used };
  }).pipe(Effect.scoped);

export const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

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

export const relayInstructions =
  "The `executor` CLI is available in this shell and reaches these same tools: `executor search`, `describe`, `call`, `execute`, `resume` and `skills`. For a large result, prefer `executor call` or `executor execute` with its output redirected to a file, for example `executor execute --file program.js > result.json`, then read only the parts you need.";

const InitializeResult = Schema.Struct({
  protocolVersion: Schema.String,
  instructions: Schema.optional(Schema.String),
});
const DiscoverResult = Schema.Struct({ instructions: Schema.optional(Schema.String) });

const withRelayInstructions = (instructions: string | undefined) =>
  instructions === undefined || instructions === ""
    ? relayInstructions
    : `${instructions}\n\n${relayInstructions}`;

const Stateless = Schema.Struct({
  params: Schema.Struct({
    _meta: Schema.Struct({ "io.modelcontextprotocol/protocolVersion": Schema.String }),
  }),
});
const Cancellation = Schema.Struct({
  method: Schema.Literal("notifications/cancelled"),
  params: Schema.Struct({ requestId: Schema.Union([Schema.String, Schema.Number]) }),
});
const decodeJsonBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const hostAnswer = (error: unknown, id: string | number) => {
  if (!(error instanceof SdkHttpError) || error.status === 401 || error.status === 403)
    return Option.none();
  const text = error.data["text"];
  return (typeof text === "string" ? decodeJsonBody(text) : Option.none()).pipe(
    Option.filter(
      (body): body is JSONRPCErrorResponse => isJSONRPCErrorResponse(body) && body.id === id,
    ),
  );
};

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

const sessionForgotten = (error: unknown) => error instanceof SdkHttpError && error.status === 404;

const reinitializeTimeoutMs = 60_000;

class ReinitializeFailed extends Error {}

export const relay = <E>(target: ToolsTarget<E>) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<never>();
    const report = (message: string) => Effect.runForkWith(services)(Console.error(message));
    const failures: Array<unknown> = [];
    const open = () =>
      new RelayUpstreamTransport(new URL(target.url), {
        fetch: authorizedFetch(target, failures),
      });
    let upstream = open();
    yield* Effect.addFinalizer(() => Effect.promise(() => upstream.close()));
    const downstream = yield* Effect.acquireRelease(
      Effect.sync(() => new StdioServerTransport()),
      (transport) => Effect.promise(() => transport.close()),
    );
    yield* Effect.callback<void>((resume) => {
      const instructing = new Map<string | number, "initialize" | "server/discover">();
      let initialize: JSONRPCRequest | undefined;
      const reinitializing = new Map<string, (message: JSONRPCMessage) => void>();
      let reinitializations = 0;
      let reopening: Promise<void> | undefined;
      const stateless = new Map<string | number, AbortController>();

      const wire = (transport: RelayUpstreamTransport) => {
        transport.onmessage = (message) => {
          if (
            (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
            typeof message.id === "string"
          ) {
            const answer = reinitializing.get(message.id);
            if (answer !== undefined) return answer(message);
          }
          if (isJSONRPCErrorResponse(message) && message.id !== undefined) {
            instructing.delete(message.id);
            stateless.delete(message.id);
          }
          if (isJSONRPCResultResponse(message)) stateless.delete(message.id);
          let forwarded: JSONRPCMessage = message;
          const answered = isJSONRPCResultResponse(message)
            ? instructing.get(message.id)
            : undefined;
          if (isJSONRPCResultResponse(message) && answered !== undefined) {
            instructing.delete(message.id);
            const instructions =
              answered === "initialize"
                ? Option.map(
                    Schema.decodeUnknownOption(InitializeResult)(message.result),
                    (initialized) => {
                      transport.setProtocolVersion(initialized.protocolVersion);
                      return initialized.instructions;
                    },
                  )
                : Option.map(
                    Schema.decodeUnknownOption(DiscoverResult)(message.result),
                    (discovered) => discovered.instructions,
                  );
            if (Option.isSome(instructions))
              forwarded = {
                ...message,
                result: {
                  ...message.result,
                  instructions: withRelayInstructions(instructions.value),
                },
              };
          }
          downstream.send(forwarded).catch(() => resume(Effect.void));
        };
        transport.onerror = (error) => {
          if (transport !== upstream || sessionForgotten(error)) return;
          report(
            `executor mcp: ${relayRefusal(toolFailure(target, "relay", failures.slice())(error))}`,
          );
        };
      };

      const reopen = (lost: RelayUpstreamTransport, original: JSONRPCRequest) => {
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

      const forward = async (message: JSONRPCMessage, cancelled?: AbortSignal) => {
        const via = upstream;
        try {
          await via.send(
            message,
            cancelled === undefined ? undefined : { requestSignal: cancelled },
          );
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
        if (
          isJSONRPCRequest(message) &&
          (message.method === "initialize" || message.method === "server/discover")
        )
          instructing.set(message.id, message.method);
        if (isJSONRPCRequest(message) && message.method === "initialize") initialize = message;
        if (Schema.is(Cancellation)(message)) {
          const cancelled = stateless.get(message.params.requestId);
          stateless.delete(message.params.requestId);
          cancelled?.abort();
          if (cancelled !== undefined || Schema.is(Stateless)(message)) return;
        }
        const request =
          isJSONRPCRequest(message) && Schema.is(Stateless)(message)
            ? new AbortController()
            : undefined;
        if (request !== undefined && isJSONRPCRequest(message)) stateless.set(message.id, request);
        forward(message, request?.signal).catch((error: unknown) => {
          if (request?.signal.aborted === true) return;
          const refusal =
            error instanceof ReinitializeFailed
              ? `Executor no longer knows this MCP session, and opening a new one failed: ${error.message}`
              : relayRefusal(toolFailure(target, "relay", failures.splice(0))(error));
          if (!isJSONRPCRequest(message)) {
            report(`executor mcp: ${refusal}`);
            return;
          }
          stateless.delete(message.id);
          instructing.delete(message.id);
          const refused: JSONRPCErrorResponse = {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: refusal },
          };
          return downstream.send(
            request === undefined
              ? refused
              : Option.getOrElse(hostAnswer(error, message.id), () => refused),
          );
        });
      };
      downstream.onerror = () => resume(Effect.void);
      downstream.onclose = () => resume(Effect.void);
      process.stdin.once("end", () => resume(Effect.void));
      upstream
        .start()
        .then(() => downstream.start())
        .catch(() => resume(Effect.void));
    });
  }).pipe(Effect.scoped);
