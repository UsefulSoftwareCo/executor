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

export const makeMcpSurface = (target: Target): McpSurface => ({
  mintBearer: (email) =>
    Effect.promise(async () => {
      const consent = target.mcpConsent?.({ label: email, credentials: { email, password: "" } });
      if (!consent) throw new Error(`target ${target.name} has no mcpConsent strategy`);

      const mcpPath = new URL(target.mcpUrl).pathname;
      const resource = (await (
        await fetch(new URL(`/.well-known/oauth-protected-resource${mcpPath}`, target.baseUrl))
      ).json()) as { readonly authorization_servers?: ReadonlyArray<string> };
      const issuer = resource.authorization_servers?.[0];
      if (!issuer) throw new Error("mintBearer: no authorization server advertised");
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
            grant_types: ["authorization_code"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
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
      ).json()) as { readonly access_token?: string };
      if (!token.access_token) throw new Error("mintBearer: token exchange returned no token");
      return token.access_token;
    }),
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
