// ---------------------------------------------------------------------------
// The MCP connection to Executor.
//
// Opened on the first tool call, never at startup: Pi must start cleanly even
// when Executor is unreachable, misconfigured, or simply not running yet.
// ---------------------------------------------------------------------------

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  TOKEN_ENV_VARS,
  type PiExecutorConfig,
  type PiTokenSource,
  type ResolvedPiExecutorConfig,
} from "./config";

const CLIENT_INFO = { name: "executor-pi", version: "0.1.0" } as const;

export interface ExecutorConnection {
  readonly resolved: ResolvedPiExecutorConfig;
  readonly callTool: (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) => Promise<CallToolResult>;
  /** Tool names Executor currently serves. Used by `/executor` to prove reachability. */
  readonly listToolNames: () => Promise<readonly string[]>;
  readonly close: () => Promise<void>;
}

/**
 * What to do about a credential the server refused. The two variables are
 * refilled from different places — a hosted Executor has an API Keys page, a
 * local or desktop one hands out its own server token and has no such page — so
 * the remedy follows the variable the token actually came from.
 */
const rejectedTokenHint = (source: PiTokenSource): string =>
  source === TOKEN_ENV_VARS[0]
    ? `The API key in ${TOKEN_ENV_VARS[0]} was rejected — mint a fresh one on Executor's API Keys page.`
    : `The token in ${TOKEN_ENV_VARS[1]} was rejected — copy your local or desktop server's current token again (the "Connect an agent" card's command carries it).`;

const describeFailure = (error: unknown, config: PiExecutorConfig): Error => {
  const detail = error instanceof Error ? error.message : String(error);
  // Executor answers an unauthenticated MCP POST with an OAuth challenge, and
  // the SDK surfaces it as `invalid_token` — often with no status code in the
  // message at all. Match the vocabulary, not just the number.
  const unauthorized = /\b(401|403)\b|unauthorized|forbidden|invalid_token/i.test(detail);
  const hint =
    config.tokenSource === null
      ? `No token is set — put a hosted API key in ${TOKEN_ENV_VARS[0]}, or a local or desktop server's bearer token in ${TOKEN_ENV_VARS[1]}.`
      : unauthorized
        ? rejectedTokenHint(config.tokenSource)
        : "A token was sent.";
  return new Error(`Could not reach Executor at ${config.endpoint}. ${hint} (${detail})`);
};

export const createExecutorConnection = (
  resolved: ResolvedPiExecutorConfig,
): ExecutorConnection => {
  // A single in-flight connect, so parallel tool calls share one MCP session
  // rather than racing two.
  let pending: Promise<Client> | null = null;

  const connect = async (config: PiExecutorConfig): Promise<Client> => {
    const client = new Client(CLIENT_INFO);
    const transport = new StreamableHTTPClientTransport(new URL(config.endpoint), {
      requestInit:
        config.authorization === null
          ? undefined
          : { headers: { Authorization: config.authorization } },
    });
    await client.connect(transport);
    return client;
  };

  const connected = (): Promise<Client> => {
    if (!resolved.ok) return Promise.reject(new Error(resolved.reason));
    const config = resolved.config;
    if (pending === null) {
      pending = connect(config).catch((error: unknown) => {
        // A failed connect must not poison every later call: clear the memo so
        // the next one retries (Executor may just have been starting up).
        pending = null;
        throw describeFailure(error, config);
      });
    }
    return pending;
  };

  /**
   * Rejections here are transport or protocol failures, not tool failures —
   * a failing Executor tool comes back as a result with `isError`. So a
   * rejection means this session is suspect: drop it and let the next call
   * reconnect, which is what makes an Executor restart survivable without
   * restarting Pi.
   */
  const withSession = async <A>(use: (client: Client) => Promise<A>): Promise<A> => {
    const client = await connected();
    try {
      return await use(client);
    } catch (error) {
      pending = null;
      void client.close().catch(() => undefined);
      throw error;
    }
  };

  return {
    resolved,
    callTool: (name, args, signal) =>
      // `callTool` types its result as the union of the modern shape and the
      // 2024-10-07 `{ toolResult }` one, because the overload accepts either
      // schema. Passing `CallToolResultSchema` is what actually decides it, so
      // the modern branch is the only one that can arrive here.
      withSession((client) =>
        client.callTool({ name, arguments: args }, CallToolResultSchema, { signal }),
      ) as Promise<CallToolResult>,
    listToolNames: () =>
      withSession(async (client) => {
        const listed = await client.listTools();
        return listed.tools.map((tool) => tool.name);
      }),
    close: async () => {
      const current = pending;
      pending = null;
      if (current === null) return;
      await current.then((client) => client.close()).catch(() => undefined);
    },
  };
};
