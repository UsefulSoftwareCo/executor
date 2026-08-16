import { Effect } from "effect";
import {
  Client,
  StreamableHTTPClientTransport,
  withInputRequired,
  type InputRequiredResult,
  type Request as McpRequest,
} from "@modelcontextprotocol/client";
import { CallToolResultSchema } from "@modelcontextprotocol/core";

/** The first MCP revision served through the modern per-request protocol. */
export const MODERN_MCP_PROTOCOL_VERSION = "2026-07-28";

/** Negotiation postures covered by the modern e2e client. */
export type ModernMcpNegotiationMode =
  | "auto"
  | { readonly pin: typeof MODERN_MCP_PROTOCOL_VERSION };

/** Connection inputs for a scoped modern MCP client. */
export type ModernMcpClientOptions = {
  readonly url: string;
  readonly bearer: string;
  readonly mode: ModernMcpNegotiationMode;
  readonly manualInputRequired?: boolean;
};

const makeClient = (mode: ModernMcpNegotiationMode, manualInputRequired: boolean): Client =>
  new Client(
    { name: "executor-modern-e2e", version: "1.0.0" },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode },
      ...(manualInputRequired ? { inputRequired: { autoFulfill: false } } : {}),
    },
  );

/**
 * Connect a real v2 MCP client and close it when the surrounding Effect scope
 * ends. The caller selects pinned or auto negotiation explicitly.
 */
export const connectModernMcpClient = (options: ModernMcpClientOptions) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const client = makeClient(options.mode, options.manualInputRequired ?? false);
      const transport = new StreamableHTTPClientTransport(new URL(options.url), {
        requestInit: { headers: { authorization: `Bearer ${options.bearer}` } },
      });
      await client.connect(transport);
      return client;
    }),
    (client) => Effect.promise(() => client.close()).pipe(Effect.ignore),
  );

/**
 * Issue a modern tool call in manual input-required mode, returning either the
 * completed tool result or the server's next input request.
 */
export const callModernToolWithInputRequired = (
  client: Client,
  params: Record<string, unknown>,
): Effect.Effect<InputRequiredResult | Awaited<ReturnType<Client["callTool"]>>> => {
  const request: McpRequest = { method: "tools/call", params };
  return Effect.promise(() =>
    client.request(request, withInputRequired(CallToolResultSchema), {
      allowInputRequired: true,
    }),
  );
};

/** Join the text content returned by an MCP tool call. */
export const modernToolText = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

/** The authentication response observed during an unauthenticated modern probe. */
export type ModernMcpAuthChallenge = {
  readonly status: number | undefined;
  readonly wwwAuthenticate: string | null;
};

/**
 * Drive the real pinned-modern probe without credentials and capture the HTTP
 * authentication challenge that prevented the connection.
 */
export const readModernMcpAuthChallenge = (url: string): Effect.Effect<ModernMcpAuthChallenge> =>
  Effect.promise(async () => {
    let challenge: ModernMcpAuthChallenge = {
      status: undefined,
      wwwAuthenticate: null,
    };
    const client = makeClient({ pin: MODERN_MCP_PROTOCOL_VERSION }, false);
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (response.status === 401) {
          challenge = {
            status: response.status,
            wwwAuthenticate: response.headers.get("www-authenticate"),
          };
        }
        return response;
      },
    });
    await client.connect(transport).then(
      () => undefined,
      () => undefined,
    );
    await client.close();
    return challenge;
  });
