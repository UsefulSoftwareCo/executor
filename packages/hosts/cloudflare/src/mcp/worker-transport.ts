import { WorkerTransport, type WorkerTransportOptions } from "agents/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Data, Effect } from "effect";

import { JsonRpcRequestIdQueue } from "./request-id-queue.js";

export { JsonRpcRequestIdQueue, PREVIOUS_REQUEST_TIMEOUT_MS } from "./request-id-queue.js";

export class McpWorkerTransportError extends Data.TaggedError("McpWorkerTransportError")<{
  readonly cause: unknown;
}> {}

export type McpWorkerTransport = Readonly<{
  transport: WorkerTransport;
  connect: (server: McpServer) => Effect.Effect<void, McpWorkerTransportError>;
  handleRequest: (request: Request) => Effect.Effect<Response, McpWorkerTransportError>;
  close: () => Effect.Effect<void>;
}>;

type HandleRequestResult = {
  readonly response: Response;
  readonly replacedStandaloneSse: boolean;
};

const closeExistingStandaloneSse = (transport: WorkerTransport): boolean => {
  const streamId =
    typeof Reflect.get(transport, "standaloneSseStreamId") === "string"
      ? Reflect.get(transport, "standaloneSseStreamId")
      : "_GET_stream";
  const streamMapping = Reflect.get(transport, "streamMapping");
  if (!(streamMapping instanceof Map)) return false;

  const stream = streamMapping.get(streamId);
  if (!stream) return false;

  if (
    typeof stream === "object" &&
    stream !== null &&
    typeof Reflect.get(stream, "cleanup") === "function"
  ) {
    Reflect.get(stream, "cleanup")();
  }
  streamMapping.delete(streamId);
  return true;
};

const isStandaloneSseGet = (request: Request): boolean =>
  request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/event-stream");

export const makeMcpWorkerTransport = (
  options: WorkerTransportOptions,
): Effect.Effect<McpWorkerTransport> =>
  Effect.sync(() => {
    const transport = new WorkerTransport(options);
    const requestIdQueue = new JsonRpcRequestIdQueue();

    const use = <A>(name: string, fn: () => Promise<A>) =>
      Effect.tryPromise({
        try: fn,
        catch: (cause) => new McpWorkerTransportError({ cause }),
      }).pipe(Effect.withSpan(`mcp.worker_transport.${name}`));

    const handleWithStandaloneSseReplacement = async (
      request: Request,
    ): Promise<HandleRequestResult> => {
      if (!isStandaloneSseGet(request)) {
        return {
          response: await transport.handleRequest(request),
          replacedStandaloneSse: false,
        };
      }

      const initial = await transport.handleRequest(request);
      if (initial.status !== 409) {
        return { response: initial, replacedStandaloneSse: false };
      }

      const replacedStandaloneSse = closeExistingStandaloneSse(transport);
      return {
        response: replacedStandaloneSse ? await transport.handleRequest(request) : initial,
        replacedStandaloneSse,
      };
    };

    return {
      transport,
      connect: (server: McpServer) => use("connect", () => server.connect(transport)),
      handleRequest: (request: Request) =>
        Effect.gen(function* () {
          const result = yield* use("handle_request", () =>
            requestIdQueue.run(request, () => handleWithStandaloneSseReplacement(request)),
          );
          yield* Effect.annotateCurrentSpan({
            "mcp.transport.replaced_standalone_sse": result.replacedStandaloneSse,
          });
          return result.response;
        }),
      close: () =>
        Effect.ignore(
          Effect.tryPromise({
            try: () => transport.close(),
            catch: (cause) => new McpWorkerTransportError({ cause }),
          }),
        ).pipe(Effect.withSpan("mcp.worker_transport.close")),
    } satisfies McpWorkerTransport;
  }).pipe(Effect.withSpan("mcp.worker_transport.make"));
