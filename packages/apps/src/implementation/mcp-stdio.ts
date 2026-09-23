/** Local process transport; isolated from the HTTP subpath so cloud apps never load process dependencies. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError as ProtocolError } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Effect, Schema } from "effect";
import { McpError, ProcessConfig } from "../contracts/mcp.ts";
import { mcpClient, mcpJsonSchemaValidator } from "./mcp-client.ts";
import { adaptMcpTools } from "./mcp-tools.ts";

// The client may start closing on an initialization failure. Join that same cleanup in finally.
class OwnedTransport extends StdioClientTransport {
  private closing: Promise<void> | undefined;
  private exited: Promise<void> | undefined;
  override start(): Promise<void> {
    const previous = this.onclose;
    this.exited = new Promise((resolve) => {
      this.onclose = () => {
        resolve();
        previous?.();
      };
    });
    return super.start();
  }
  override close(): Promise<void> {
    return (this.closing ??= (async () => {
      const started = this.pid !== null;
      await super.close();
      if (started) await this.exited;
    })());
  }
}

const failure = (phase: McpError["phase"], error: unknown) =>
  new McpError({
    phase,
    reason:
      error instanceof ProtocolError && error.code === ErrorCode.RequestTimeout
        ? "timeout"
        : "request",
  });

function withClient<A, E>(
  config: ProcessConfig,
  mode: "discover" | "call",
  use: (client: Client) => Effect.Effect<A, E>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const { client, transport } = yield* Effect.acquireRelease(
        Effect.sync(() => ({
          client: new Client(
            { name: "executor-app", version: "1" },
            {
              jsonSchemaValidator: mcpJsonSchemaValidator,
              capabilities: mode === "call" ? { elicitation: { form: {} } } : {},
            },
          ),
          transport: new OwnedTransport({
            command: config.command,
            args: [...config.args],
            env: { ...config.env },
            ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
            stderr: "ignore",
          }),
        })),
        ({ client, transport }) =>
          Effect.tryPromise(async () => {
            try {
              await client.close();
            } finally {
              await transport.close();
            }
          }).pipe(Effect.withSpan("provider.mcp.close"), Effect.orDie),
      );
      yield* Effect.tryPromise({
        try: (signal) => client.connect(transport, { signal, timeout: config.timeoutMs }),
        catch: (error) => failure("connect", error),
      }).pipe(Effect.timeout(config.timeoutMs), Effect.withSpan("provider.mcp.connect"));
      return yield* use(client);
    }),
  ).pipe(
    Effect.withSpan("provider.mcp.session", {
      attributes: { "mcp.transport": "stdio", "mcp.operation": mode },
    }),
    (operation) =>
      mode === "discover" ? operation.pipe(Effect.timeout(config.timeoutMs)) : operation,
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new McpError({ phase: "transport", reason: "timeout" })),
    ),
  );
}

/** Each discovery/call owns and closes its subprocess. Deployment never starts it. */
export const stdioToolsEffect = (input: ProcessConfig) =>
  Effect.gen(function* () {
    const config = yield* Schema.decodeUnknownEffect(ProcessConfig)(input).pipe(
      Effect.mapError(() => new McpError({ phase: "connect", reason: "invalid_input" })),
    );
    return yield* adaptMcpTools(
      mcpClient((mode, use) => withClient(config, mode, use), config.timeoutMs, failure),
    );
  });
