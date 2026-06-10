// MCP surface: the vendored mcporter fork as a programmatic MCP client, with
// headless OAuth via the target's consent strategy. Session methods are
// Effects; mcporter itself is promise-native underneath. Assertions are
// vitest's job.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { createRuntime, type Runtime } from "@executor-js/mcporter";

import type { Identity, Target } from "../target";

export interface McpCallResult {
  readonly raw: unknown;
  readonly text: string;
  readonly ok: boolean;
}

export interface McpSession {
  readonly listTools: () => Effect.Effect<ReadonlyArray<string>>;
  readonly call: (name: string, args?: Record<string, unknown>) => Effect.Effect<McpCallResult>;
  /** Find the paused executionId in `text` and resume it with approval. */
  readonly approvePaused: (
    text: string,
    content?: Record<string, unknown>,
  ) => Effect.Effect<McpCallResult>;
}

/** The full token grant a client holds after completing OAuth. */
export interface McpOAuthTokens {
  readonly accessToken: string;
  /** null when the authorization server issued no refresh token — the client is stranded at expiry. */
  readonly refreshToken: string | null;
  readonly expiresIn: number;
  /** Redeem the (single-use, rotating) refresh token exactly as a client would. */
  readonly refresh: () => Effect.Effect<McpOAuthTokens>;
}

export interface McpOAuthOptions {
  /** Scopes to request at /authorize. Omitted entries mean the scope param is omitted entirely. */
  readonly scopes?: ReadonlyArray<string>;
  /** Emulate DCR extension: compress the access-token lifetime so expiry is testable in seconds. */
  readonly accessTokenTtlSeconds?: number;
}

/** How a real MCP client decides which scopes to request. */
export interface McpClientScopePolicy {
  readonly name: string;
  readonly scopesToRequest: (advertised: ReadonlyArray<string>) => ReadonlyArray<string>;
}

/** OpenCode, Poke, mcporter: spec-faithful — request exactly what the resource advertises. */
export const SPEC_FAITHFUL_CLIENT: McpClientScopePolicy = {
  name: "spec-faithful (OpenCode)",
  scopesToRequest: (advertised) => advertised,
};

/** Claude Code, Codex, ChatGPT: ignore the metadata and hardcode the scopes they want. */
export const HARDCODED_SCOPES_CLIENT: McpClientScopePolicy = {
  name: "hardcoded-scopes (Claude Code)",
  scopesToRequest: () => ["openid", "profile", "email", "offline_access"],
};

export interface McpSurface {
  readonly session: (identity: Identity) => McpSession;
  /**
   * Mint a real MCP bearer exactly the way an MCP client does, headlessly:
   * protected-resource discovery → authorization-server discovery → dynamic
   * client registration → authorize with PKCE (consent via the target's
   * strategy) → code exchange. For raw-wire scenarios that drive /mcp without
   * an MCP client library.
   */
  readonly mintBearer: (email: string) => Effect.Effect<string>;
  /** The scopes_supported our protected-resource metadata advertises — what a spec-faithful client requests. */
  readonly advertisedScopes: () => Effect.Effect<ReadonlyArray<string>>;
  /** The same flow as mintBearer, but returning the whole grant (refresh token, expiry) for lifecycle scenarios. */
  readonly mintTokens: (email: string, options?: McpOAuthOptions) => Effect.Effect<McpOAuthTokens>;
}

const textOf = (result: unknown): string => {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  return typeof result === "string" ? result : JSON.stringify(result);
};

interface TokenResponse {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
}

const protectedResourceMetadata = async (
  target: Target,
): Promise<{
  readonly authorization_servers?: ReadonlyArray<string>;
  readonly scopes_supported?: ReadonlyArray<string>;
}> => {
  const mcpPath = new URL(target.mcpUrl).pathname;
  return (await (
    await fetch(new URL(`/.well-known/oauth-protected-resource${mcpPath}`, target.baseUrl))
  ).json()) as {
    authorization_servers?: ReadonlyArray<string>;
    scopes_supported?: ReadonlyArray<string>;
  };
};

/**
 * The headless MCP client OAuth dance: protected-resource discovery →
 * authorization-server discovery → DCR → authorize with PKCE (consent via the
 * target's strategy) → code exchange. Returns the whole grant plus a
 * `refresh` that redeems the rotating refresh token like a real client.
 */
const mintTokensFlow = async (
  target: Target,
  email: string,
  options: McpOAuthOptions,
): Promise<McpOAuthTokens> => {
  const consent = target.mcpConsent?.({ label: email, credentials: { email, password: "" } });
  if (!consent) throw new Error(`target ${target.name} has no mcpConsent strategy`);

  const resource = await protectedResourceMetadata(target);
  const issuer = resource.authorization_servers?.[0];
  if (!issuer) throw new Error("mintTokens: no authorization server advertised");
  const metadata = (await (
    await fetch(new URL("/.well-known/oauth-authorization-server", issuer))
  ).json()) as {
    readonly authorization_endpoint: string;
    readonly token_endpoint: string;
    readonly registration_endpoint: string;
  };

  const redirectUri = "http://127.0.0.1:9/callback";
  const registered = (await (
    await fetch(metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "executor-e2e",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(options.accessTokenTtlSeconds === undefined
          ? {}
          : { access_token_ttl_seconds: options.accessTokenTtlSeconds }),
      }),
    })
  ).json()) as { readonly client_id: string };

  const verifier = randomBytes(32).toString("base64url");
  const authorizeUrl = new URL(metadata.authorization_endpoint);
  authorizeUrl.searchParams.set("client_id", registered.client_id);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", randomUUID());
  authorizeUrl.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  if (options.scopes !== undefined && options.scopes.length > 0) {
    authorizeUrl.searchParams.set("scope", options.scopes.join(" "));
  }
  const { code } = await consent({ authorizationUrl: authorizeUrl.toString() });

  const token = (await (
    await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: registered.client_id,
        code_verifier: verifier,
      }),
    })
  ).json()) as TokenResponse;
  if (!token.access_token) throw new Error("mintTokens: token exchange returned no token");

  const toTokens = (response: TokenResponse): McpOAuthTokens => ({
    accessToken: response.access_token ?? "",
    refreshToken: response.refresh_token ?? null,
    expiresIn: response.expires_in ?? 0,
    refresh: () =>
      Effect.promise(async () => {
        if (!response.refresh_token) throw new Error("refresh: no refresh token was issued");
        const refreshed = (await (
          await fetch(metadata.token_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: response.refresh_token,
              client_id: registered.client_id,
            }),
          })
        ).json()) as TokenResponse;
        if (!refreshed.access_token) throw new Error("refresh: token endpoint returned no token");
        return toTokens(refreshed);
      }),
  });
  return toTokens(token);
};

export const makeMcpSurface = (target: Target): McpSurface => ({
  mintBearer: (email) =>
    Effect.promise(() => mintTokensFlow(target, email, {})).pipe(
      Effect.map((tokens) => tokens.accessToken),
    ),
  advertisedScopes: () =>
    Effect.promise(async () => (await protectedResourceMetadata(target)).scopes_supported ?? []),
  mintTokens: (email, options = {}) => Effect.promise(() => mintTokensFlow(target, email, options)),
  session: (identity) => {
    const serverName = target.name;
    let runtimePromise: Promise<Runtime> | undefined;
    let connected = false;

    const consent = target.mcpConsent?.(identity);
    const callOptions = {
      autoAuthorize: true,
      oauthSessionOptions: consent ? { consentStrategy: consent } : {},
    };

    const runtime = () => {
      if (!runtimePromise) {
        const dir = mkdtempSync(join(tmpdir(), "executor-e2e-mcp-"));
        writeFileSync(
          join(dir, "mcporter.json"),
          JSON.stringify({ mcpServers: { [serverName]: { url: target.mcpUrl } } }),
        );
        runtimePromise = createRuntime({ configPath: join(dir, "mcporter.json") });
      }
      return runtimePromise;
    };

    const listTools = () =>
      Effect.promise(async () => {
        const defs = await (await runtime()).listTools(serverName, callOptions);
        connected = true;
        return defs.map((tool: { name: string }) => tool.name);
      });

    const call = (name: string, args: Record<string, unknown> = {}) =>
      Effect.promise(async (): Promise<McpCallResult> => {
        if (!connected) {
          await (await runtime()).listTools(serverName, callOptions);
          connected = true;
        }
        const raw = await (await runtime()).callTool(serverName, name, { args, ...callOptions });
        const isError = Boolean((raw as { isError?: boolean })?.isError);
        return { raw, text: textOf(raw), ok: !isError };
      });

    return {
      listTools,
      call,
      approvePaused: (text, content = {}) =>
        Effect.suspend(() => {
          const match = /\bexecutionId:\s*(\S+)/.exec(text);
          if (!match) return Effect.die(new Error("approvePaused: executionId not found in text"));
          return call("resume", {
            executionId: match[1],
            action: "accept",
            content: JSON.stringify(content),
          });
        }),
    };
  },
});
