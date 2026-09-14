// ---------------------------------------------------------------------------
// Where this extension points, and how it authenticates.
//
// The environment is the only source. Pi installs this package from npm, so a
// credential in package config would be a credential in every user's
// node_modules; the issue asking for this integration called that out by name.
// ---------------------------------------------------------------------------

/** Names the Executor MCP endpoint. Copy it from the Connect an agent card. */
export const ENDPOINT_ENV_VAR = "EXECUTOR_MCP_URL";

/**
 * Bearer sources, in the CLI's own precedence order (see
 * `readCliServerAuth` in apps/cli/src/server-connection.ts): a hosted API key
 * beats a local/desktop server token.
 */
export const TOKEN_ENV_VARS = ["EXECUTOR_API_KEY", "EXECUTOR_AUTH_TOKEN"] as const;

/** Which variable a bearer came from. Hosted keys and local server tokens are
 *  minted in different places, so a rejected one has a different remedy. */
export type PiTokenSource = (typeof TOKEN_ENV_VARS)[number];

export interface PiExecutorConfig {
  /** Endpoint to POST MCP at, already pinned to model elicitation. */
  readonly endpoint: string;
  /** Full `Authorization` header value, or null when no token is configured. */
  readonly authorization: string | null;
  /** The variable that supplied `authorization`, or null when none did. */
  readonly tokenSource: PiTokenSource | null;
}

export type ResolvedPiExecutorConfig =
  | { readonly ok: true; readonly config: PiExecutorConfig }
  | { readonly ok: false; readonly reason: string };

/**
 * Pin `elicitation_mode=model`, replacing whatever the URL carried.
 *
 * The `resume` tool this extension registers has the shape Executor serves in
 * MODEL mode (`executionId` + `action` + `content`). In browser mode the server
 * registers a `resume` taking `executionId` alone, so a pasted
 * `?elicitation_mode=browser` URL would leave us advertising two parameters the
 * server rejects. Pinning the mode is what makes the fixed schema honest.
 * Unrelated query parameters (`artifacts`, `search_tools`, …) are preserved.
 */
const pinModelElicitation = (url: URL): string => {
  url.searchParams.set("elicitation_mode", "model");
  return url.toString();
};

const firstToken = (
  env: Record<string, string | undefined>,
): { readonly name: PiTokenSource; readonly value: string } | undefined => {
  for (const name of TOKEN_ENV_VARS) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) return { name, value };
  }
  return undefined;
};

/**
 * Resolve configuration without throwing: extension startup must never fail on
 * a missing or malformed endpoint. The reason is surfaced later, when a tool
 * call or `/executor` actually needs a connection.
 */
export const resolvePiExecutorConfig = (
  env: Record<string, string | undefined>,
): ResolvedPiExecutorConfig => {
  const rawEndpoint = env[ENDPOINT_ENV_VAR]?.trim();
  if (rawEndpoint === undefined || rawEndpoint.length === 0) {
    return {
      ok: false,
      reason: `${ENDPOINT_ENV_VAR} is not set. Copy the MCP URL from Executor's "Connect an agent" card, and set ${TOKEN_ENV_VARS[0]} to an API key from Executor's API Keys page — or, for a local or desktop Executor, ${TOKEN_ENV_VARS[1]} to that server's own bearer token.`,
    };
  }

  // `URL.parse` returns null instead of throwing (Node >= 22.1; Pi requires
  // >= 22.19), which keeps this module free of exception control flow.
  const url = URL.parse(rawEndpoint);
  if (url === null) {
    return { ok: false, reason: `${ENDPOINT_ENV_VAR} is not a valid URL: ${rawEndpoint}` };
  }

  const token = firstToken(env);
  return {
    ok: true,
    config: {
      endpoint: pinModelElicitation(url),
      authorization: token === undefined ? null : `Bearer ${token.value}`,
      tokenSource: token?.name ?? null,
    },
  };
};
