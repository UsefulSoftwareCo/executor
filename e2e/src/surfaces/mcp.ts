// MCP surface: our mcporter fork (@executor-js/mcporter on npm; develop it in
// the vendor/mcporter submodule) as a programmatic MCP client, with headless
// OAuth via the target's consent strategy. Session methods are Effects;
// mcporter itself is promise-native underneath. Assertions are vitest's job.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { createRuntime, type Runtime } from "@executor-js/mcporter";

import { appendTraces } from "../trace-harvest";
import type { Identity, Target } from "../target";

// ---------------------------------------------------------------------------
// Distributed traces for MCP calls. The web app's HttpClient sends a W3C
// traceparent on its own; mcporter's plain fetch does not — so the agent/CLI
// side of a session was invisible in the run's trace ledger. mcporter rides
// the global fetch, so the surface wraps it once per process: every POST to
// the target's MCP endpoint gets a freshly minted traceparent (the server
// joins whatever arrives — worker and DO both parse the header), and the
// request lands in traces.json with the JSON-RPC method as its label,
// duration, status, and source: "terminal".
// ---------------------------------------------------------------------------

let traceFetchInstalled = false;
let traceSink: { mcpUrl: string; runDir: string } | null = null;

/** JSON-RPC body → a human label: tool name for tools/call, else method. */
const rpcLabel = (body: unknown): string | undefined => {
  if (typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body) as {
      method?: string;
      params?: { name?: string };
    };
    if (!parsed.method) return undefined;
    return parsed.method === "tools/call" && parsed.params?.name
      ? `${parsed.params.name}()`
      : parsed.method;
  } catch {
    return undefined;
  }
};

const installTraceparentFetch = (mcpUrl: string, runDir: string): void => {
  traceSink = { mcpUrl, runDir };
  if (traceFetchInstalled) return;
  traceFetchInstalled = true;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const sink = traceSink;
    if (!sink || method !== "POST" || !url.startsWith(sink.mcpUrl)) {
      return original(input, init);
    }
    const traceId = randomBytes(16).toString("hex");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    headers.set("traceparent", `00-${traceId}-${randomBytes(8).toString("hex")}-01`);
    const at = Date.now();
    const finish = (status?: number) =>
      appendTraces(sink.runDir, [
        {
          id: traceId,
          at,
          url,
          ms: Date.now() - at,
          ...(status === undefined ? {} : { status }),
          source: "terminal" as const,
          label: rpcLabel(init?.body),
        },
      ]);
    try {
      const response = await original(input, { ...init, headers });
      finish(response.status);
      return response;
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- fetch adapter boundary
    } catch (error) {
      finish();
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- fetch adapter boundary
      throw error;
    }
  };
};

export interface McpCallResult {
  readonly raw: unknown;
  readonly text: string;
  readonly ok: boolean;
}

export interface McpToolDef {
  readonly name: string;
  readonly description: string;
}

export interface McpSession {
  readonly listTools: () => Effect.Effect<ReadonlyArray<string>>;
  /** Full advertised tool definitions — for asserting on the description text
   *  an MCP client actually reads (e.g. the execute tool's inventory). */
  readonly describeTools: () => Effect.Effect<ReadonlyArray<McpToolDef>>;
  readonly call: (name: string, args?: Record<string, unknown>) => Effect.Effect<McpCallResult>;
  /** Find the paused executionId in `text` and resume it with approval. */
  readonly approvePaused: (
    text: string,
    content?: Record<string, unknown>,
  ) => Effect.Effect<McpCallResult>;
}

export interface McpSurface {
  /** The target's MCP endpoint — yield this surface to depend on it existing. */
  readonly url: string;
  readonly session: (identity: Identity) => McpSession;
  /**
   * Mint a real MCP bearer headlessly: protected-resource discovery →
   * authorization-server discovery → dynamic client registration → authorize
   * with PKCE (consent via the target's strategy) → code exchange. Plumbing
   * for raw-wire scenarios that drive /mcp without an MCP client library —
   * client *behavior* (scope choices, refresh, token storage) is never
   * modeled here; that's what driving the real client binaries is for.
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

interface TokenResponse {
  readonly access_token?: string;
}

const mintBearerFlow = async (target: Target, email: string): Promise<string> => {
  const consent = target.mcpConsent?.({
    label: email,
    credentials: { email, password: "" },
  });
  if (!consent) throw new Error(`target ${target.name} has no mcpConsent strategy`);

  const mcpPath = new URL(target.mcpUrl).pathname;
  const resource = (await (
    await fetch(new URL(`/.well-known/oauth-protected-resource${mcpPath}`, target.baseUrl))
  ).json()) as { authorization_servers?: ReadonlyArray<string> };
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
        grant_types: ["authorization_code", "refresh_token"],
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
  const { code } = await consent({
    authorizationUrl: authorizeUrl.toString(),
    redirectUrl: redirectUri,
  });

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
  if (!token.access_token) throw new Error("mintBearer: token exchange returned no token");
  return token.access_token;
};

export const makeMcpSurface = (target: Target, runDir?: string): McpSurface => ({
  url: target.mcpUrl,
  mintBearer: (email) => Effect.promise(() => mintBearerFlow(target, email)),
  session: (identity) => {
    if (runDir) installTraceparentFetch(target.mcpUrl, runDir);
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
          JSON.stringify({
            mcpServers: { [serverName]: { url: target.mcpUrl } },
          }),
        );
        runtimePromise = createRuntime({
          configPath: join(dir, "mcporter.json"),
        });
      }
      return runtimePromise;
    };

    const listTools = () =>
      Effect.promise(async () => {
        const defs = await (await runtime()).listTools(serverName, callOptions);
        connected = true;
        return defs.map((tool: { name: string }) => tool.name);
      });

    const describeTools = () =>
      Effect.promise(async (): Promise<ReadonlyArray<McpToolDef>> => {
        const defs = await (await runtime()).listTools(serverName, callOptions);
        connected = true;
        return defs.map((tool: { name: string; description?: string }) => ({
          name: tool.name,
          description: tool.description ?? "",
        }));
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
      describeTools,
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
