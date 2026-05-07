import { WorkerTransport, type WorkerTransportOptions } from "agents/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Data, Effect, Exit, Match, Option } from "effect";

export class McpWorkerTransportError extends Data.TaggedError("McpWorkerTransportError")<{
  readonly cause: unknown;
}> {}

export type McpWorkerTransport = Readonly<{
  transport: WorkerTransport;
  connect: (server: McpServer) => Effect.Effect<void, McpWorkerTransportError>;
  handleRequest: (request: Request) => Effect.Effect<Response, McpWorkerTransportError>;
  close: () => Effect.Effect<void>;
}>;

type JsonRpcLike = {
  readonly id?: unknown;
  readonly method?: unknown;
};

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

const jsonRpcRequestIdKey = (id: unknown): string | null =>
  Match.value(id).pipe(
    Match.whenOr(
      Match.string,
      Match.number,
      Match.boolean,
      (value) => `${typeof value}:${String(value)}`,
    ),
    Match.option,
    Option.getOrNull,
  );

const extractJsonRpcRequestIdKeys = async (request: Request): Promise<ReadonlyArray<string>> => {
  if (request.method !== "POST") return [];
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return [];

  const parsed = await Effect.runPromiseExit(Effect.tryPromise(() => request.clone().json()));
  if (Exit.isFailure(parsed)) {
    return [];
  }
  const messages = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const rpc = message as JsonRpcLike;
    if (typeof rpc.method !== "string") return [];
    const key = jsonRpcRequestIdKey(rpc.id);
    return key ? [key] : [];
  });
};

// Hard ceiling on how long a same-id JSON-RPC request will wait for an
// earlier in-flight one to finish. Stays well under the 180s upstream
// client timeout that Claude / Cowork enforce, so a poisoned queue slot
// can't block the next request long enough for the client to give up.
// If a previous request hasn't released within the budget, we proceed
// anyway — at worst the MCP SDK rejects the second reply for a duplicate
// id, which is recoverable; a perma-stuck queue is not.
export const PREVIOUS_REQUEST_TIMEOUT_MS = 60_000;

export class JsonRpcRequestIdQueue {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly previousTimeoutMs: number;

  constructor(options: { readonly previousTimeoutMs?: number } = {}) {
    this.previousTimeoutMs = options.previousTimeoutMs ?? PREVIOUS_REQUEST_TIMEOUT_MS;
  }

  async run<A>(request: Request, run: () => Promise<A>): Promise<A> {
    const ids = [...new Set(await extractJsonRpcRequestIdKeys(request))];
    if (ids.length === 0) return await run();

    const previous = ids.map((id) => this.inFlight.get(id)).filter((p) => p !== undefined);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const id of ids) {
      this.inFlight.set(id, current);
    }

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: promise queue must release in-flight ids after callback completion
    try {
      if (previous.length > 0) {
        const settled = Promise.all(
          previous.map((p) => Effect.runPromise(Effect.ignore(Effect.tryPromise(() => p)))),
        );
        const timeout = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), this.previousTimeoutMs),
        );
        const outcome = await Promise.race([settled.then(() => "settled" as const), timeout]);
        if (outcome === "timeout") {
          console.warn(
            `[mcp-worker-transport] previous in-flight request for ids=${JSON.stringify(ids)} did not release within ${this.previousTimeoutMs}ms; proceeding anyway`,
          );
        }
      }
      return await run();
    } finally {
      for (const id of ids) {
        if (this.inFlight.get(id) === current) {
          this.inFlight.delete(id);
        }
      }
      release();
    }
  }
}

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
