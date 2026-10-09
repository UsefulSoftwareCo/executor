import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
/** Official MCP client adapter. Only public wire traffic crosses the application boundary. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { Evidence } from "./evidence.ts";
import { Target, driver } from "./platform.ts";

const Rpc = Schema.Struct({ method: Schema.optional(Schema.String) });
const make = Effect.gen(function* () {
  const target = yield* Target,
    evidence = yield* Evidence;
  return {
    connect: (
      accessToken: Redacted.Redacted<string>,
      label: string,
      options: {
        /** X-Executor-Organization, read for every request so a client can follow a renamed slug. */
        readonly organization?: string | (() => string);
        readonly mode?: "model" | "native" | "browser";
        /** A scoped connection's URL; its grants are only valid at that URL. */
        readonly connection?: string;
        /** Runs while a native client holds an approval request, before it accepts. */
        readonly whileApproving?: Effect.Effect<void, unknown>;
        /** Another origin that serves the product's MCP endpoint, such as a Cloud role host. */
        readonly origin?: string;
      } = {},
    ) =>
      Effect.gen(function* () {
        const requests: { method: string; protocol: string | null; status: number }[] = [];
        const client = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new Client(
                { name: "executor-e2e", version: "1" },
                options.mode === "native" ? { capabilities: { elicitation: { form: {} } } } : {},
              ),
          ),
          (client) => driver("close MCP client", () => client.close()).pipe(Effect.orDie),
        );
        let elicitationCount = 0;
        const whileApproving = options.whileApproving ?? Effect.void;
        if (options.mode === "native")
          client.setRequestHandler(ElicitRequestSchema, () => {
            elicitationCount += 1;
            // oxlint-disable-next-line executor/no-manual-effect-runtime-in-tests -- the MCP SDK request handler returns a Promise
            return Effect.runPromise(
              whileApproving.pipe(Effect.as({ action: "accept" as const, content: {} })),
            );
          });
        // Record methods, revisions and timing only. OAuth headers and tool arguments are excluded.
        const observedFetch: typeof fetch = (input, init) =>
          // oxlint-disable-next-line executor/no-manual-effect-runtime-in-tests -- the MCP SDK transport takes a Promise-returning fetch
          Effect.runPromise(
            Effect.gen(function* () {
              const request = new Request(input, init);
              const organization = options.organization;
              if (organization !== undefined)
                request.headers.set(
                  "X-Executor-Organization",
                  typeof organization === "string" ? organization : organization(),
                );
              const started = yield* Clock.currentTimeMillis;
              const traceId = randomBytes(16).toString("hex"),
                spanId = randomBytes(8).toString("hex");
              request.headers.set("traceparent", `00-${traceId}-${spanId}-01`);
              const rpc =
                request.method === "POST"
                  ? yield* driver("read outgoing MCP method", () => request.clone().text()).pipe(
                      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Rpc))),
                    )
                  : {};
              yield* evidence.sending({ method: request.method, path: "/mcp", traceId, spanId });
              const response = yield* driver("MCP HTTP request", (signal) =>
                fetch(request, {
                  signal: AbortSignal.any([signal, request.signal]),
                }),
              );
              const ended = yield* Clock.currentTimeMillis;
              const method = rpc.method ?? request.method;
              requests.push({
                method,
                protocol: request.headers.get("mcp-protocol-version"),
                status: response.status,
              });
              yield* evidence.request(
                {
                  method: request.method,
                  path: "/mcp",
                  status: response.status,
                  durationMs: ended - started,
                  traceId,
                },
                {
                  traceId,
                  spanId,
                  name: `MCP ${method}`,
                  kind: 3,
                  startTimeUnixNano: String(BigInt(started) * 1000000n),
                  endTimeUnixNano: String(BigInt(ended) * 1000000n),
                  status: { code: response.status >= 400 ? 2 : 1 },
                },
              );
              return response;
            }),
          );
        const endpoint = new URL(`${options.origin ?? target.metadata.origin}/mcp`);
        if (options.connection !== undefined)
          endpoint.searchParams.set("connection", options.connection);
        if (options.mode !== undefined) endpoint.searchParams.set("elicitation_mode", options.mode);
        const transport = new StreamableHTTPClientTransport(endpoint, {
          requestInit: {
            headers: { authorization: `Bearer ${Redacted.value(accessToken)}` },
          },
          fetch: observedFetch,
        });
        // SDK's optional sessionId getter includes undefined; its Transport declaration omits it.
        const compatible: Omit<StreamableHTTPClientTransport, "sessionId"> = transport;
        yield* Effect.addFinalizer(() =>
          evidence.json(`mcp-${label}.json`, {
            client: { name: "executor-e2e", version: "1" },
            server: client.getServerVersion(),
            capabilities: client.getServerCapabilities(),
            requests,
          }),
        );
        yield* driver("initialize MCP client", () => client.connect(compatible));
        return {
          elicitationCount: Effect.sync(() => elicitationCount),
          use: <A>(
            operation: string,
            action: (client: Client, signal: AbortSignal) => Promise<A>,
          ) =>
            evidence.step(
              operation,
              driver(operation, (signal) => action(client, signal)),
            ),
        };
      }),
  };
});
/** Case-scoped factory: each opened protocol connection has its own Effect lifetime. */
export class McpClient extends Context.Service<McpClient, Effect.Success<typeof make>>()(
  "e2e/McpClient",
) {
  static readonly layer = Layer.effect(McpClient, make);
}
