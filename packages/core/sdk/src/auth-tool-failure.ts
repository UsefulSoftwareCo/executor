import { ToolResult, type ToolError } from "./tool-result";

export type AuthToolFailureCode =
  | "credential_binding_missing"
  | "credential_secret_missing"
  | "credential_rejected"
  | "oauth_connection_missing"
  | "oauth_connection_failed"
  | "oauth_reauth_required";

export type AuthToolFailureInput = {
  readonly code: AuthToolFailureCode;
  readonly message: string;
  readonly source?: {
    readonly id: string;
    readonly scope?: string;
  };
  readonly credential?: {
    readonly kind: "secret" | "connection" | "oauth" | "upstream";
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

const authRecovery = (input?: AuthToolFailureInput["recovery"]) => ({
  secretsUrl: "https://executor.sh/secrets",
  createSecretTool: "executor.coreTools.secrets.create",
  startOAuthTool: "executor.coreTools.oauth.start",
  listConnectionsTool: "executor.coreTools.connections.list",
  ...(input?.configureSourceTool ? { configureSourceTool: input.configureSourceTool } : {}),
  secretInstructions:
    "For API keys, tokens, and other manually entered credentials, call createSecretTool and give the returned browser URL to the user before configuring the source binding.",
  oauthInstructions:
    "For OAuth credentials, call startOAuthTool and give the returned authorizationUrl to the user, then bind the completed connection with the source configuration tool.",
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
