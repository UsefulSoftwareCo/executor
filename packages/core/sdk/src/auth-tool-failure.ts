import { ToolResult, type ToolError } from "./tool-result";

export type AuthToolFailureCode =
  | "connection_value_missing"
  | "connection_rejected"
  | "oauth_connection_missing"
  | "oauth_refresh_failed"
  | "oauth_reauth_required";

export type AuthToolFailureInput = {
  readonly code: AuthToolFailureCode;
  readonly message: string;
  readonly source?: {
    readonly id: string;
    readonly scope?: string;
  };
  readonly credential?: {
    readonly kind: "secret" | "oauth" | "upstream";
    readonly label?: string;
    readonly slotKey?: string;
    readonly secretId?: string;
    readonly connectionId?: string;
  };
  readonly status?: number;
  readonly upstream?: {
    readonly status?: number;
    readonly details?: unknown;
  };
  readonly recovery?: {
    readonly configureSourceTool?: string;
  };
};

// In v1.5 a connection IS the credential: there is no standalone secret to
// "bind" to a source afterward. Manually-entered credentials are created via
// the connection handoff (the user enters the value in the web UI, which
// creates the bound connection in one step); OAuth credentials are minted by
// the OAuth start flow. These strings are read by the agent resolving the
// failure, so they must name tools that actually exist on the executor.
const authRecovery = (input?: AuthToolFailureInput["recovery"]) => ({
  createConnectionTool: "executor.coreTools.connections.createHandoff",
  startOAuthTool: "executor.coreTools.oauth.start",
  listConnectionsTool: "executor.coreTools.connections.list",
  ...(input?.configureSourceTool ? { configureSourceTool: input.configureSourceTool } : {}),
  connectionInstructions:
    "For API keys and tokens, call createConnectionTool for the integration to get a browser URL; the user enters the credential there, which creates the bound connection. Do not ask the user to paste secrets into chat. Then call listConnectionsTool to confirm the connection exists before retrying this tool.",
  oauthInstructions:
    "For OAuth credentials, call startOAuthTool and give the returned authorizationUrl to the user. The completed connection binds automatically, then retry the tool.",
});

export const authToolFailure = <T = never>(input: AuthToolFailureInput): ToolResult<T> => {
  const error: ToolError = {
    code: input.code,
    message: input.message,
    retryable: false,
    ...(input.status !== undefined ? { status: input.status } : {}),
    details: {
      category: "authentication",
      ...(input.source ? { source: input.source } : {}),
      ...(input.credential ? { credential: input.credential } : {}),
      ...(input.upstream ? { upstream: input.upstream } : {}),
      recovery: authRecovery(input.recovery),
    },
  };
  return ToolResult.fail(error);
};
