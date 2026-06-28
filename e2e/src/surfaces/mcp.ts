// MCP surface: our mcporter fork (@executor-js/mcporter on npm; developed in
// its own repo, github.com/UsefulSoftwareCo/mcporter) as a programmatic MCP
// client, with headless OAuth via the target's consent strategy. Session
// methods are Effects;
// mcporter itself is promise-native underneath. Assertions are vitest's job.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { createRuntime, type Runtime } from "@executor-js/mcporter";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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

/** How a connection surfaces a paused (approval-gated) execution. `browser` is
 *  what the browser-approval scenarios drive: the pause yields an `approvalUrl`
 *  for a human to open instead of letting the model resume inline. */
export type McpElicitationMode = "browser" | "model" | "native";

/** The paused-execution handle a `browser`-mode call returns: the id to resume
 *  and the console URL a human opens to approve or decline it. */
export interface McpBrowserApproval {
  readonly executionId: string;
  readonly approvalUrl: string;
}

/**
 * Pull the `{ executionId, approvalUrl }` out of a `browser`-mode paused result.
 * Throws if the call did not pause for approval (so a missing gate fails loudly
 * rather than silently skipping the browser leg).
 */
export const parseBrowserApproval = (result: McpCallResult): McpBrowserApproval => {
  const structured = (result.raw as { structuredContent?: unknown })?.structuredContent;
  const record = (structured ?? {}) as {
    status?: unknown;
    executionId?: unknown;
    approvalUrl?: unknown;
  };
  if (
    record.status !== "user_approval_required" ||
    typeof record.executionId !== "string" ||
    typeof record.approvalUrl !== "string"
  ) {
    throw new Error(
      `expected a browser approval-required result, got: ${JSON.stringify(structured)}`,
    );
  }
  return { executionId: record.executionId, approvalUrl: record.approvalUrl };
};

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
  /**
   * Call `resume` with only an executionId — the browser-mode contract, where
   * `resume` long-polls until a human records a decision through the console.
   * Run this concurrently with the browser leg that approves/declines.
   */
  readonly awaitResume: (executionId: string) => Effect.Effect<McpCallResult>;
}

export interface McpSurface {
  /** The target's MCP endpoint — yield this surface to depend on it existing. */
  readonly url: string;
  readonly session: (
    identity: Identity,
    options?: { readonly elicitationMode?: McpElicitationMode; readonly url?: string },
  ) => McpSession;
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

const jsonFrom = async <T>(response: Response, label: string): Promise<T> => {
  const text = await response.text();
  if (!text) {
    throw new Error(`${label}: empty response body (status ${response.status})`);
  }
  if (!response.ok) {
    throw new Error(`${label}: request failed (status ${response.status}): ${text}`);
  }
  return JSON.parse(text) as T;
};

const mintBearerFlow = async (target: Target, email: string): Promise<string> => {
  const consent = target.mcpConsent?.({
    label: email,
    credentials: { email, password: "" },
  });
  if (!consent) throw new Error(`target ${target.name} has no mcpConsent strategy`);

  const mcpPath = new URL(target.mcpUrl).pathname;
  let resourceResponse = await fetch(
    new URL(`/.well-known/oauth-protected-resource${mcpPath}`, target.baseUrl),
  );
  if (resourceResponse.status === 404) {
    resourceResponse = await fetch(
      new URL("/.well-known/oauth-protected-resource", target.baseUrl),
    );
  }
  const resource = await jsonFrom<{ authorization_servers?: ReadonlyArray<string> }>(
    resourceResponse,
    "mintBearer: protected-resource metadata",
  );
  const issuer = resource.authorization_servers?.[0];
  if (!issuer) throw new Error("mintBearer: no authorization server advertised");
  const metadata = await jsonFrom<{
    readonly authorization_endpoint: string;
    readonly token_endpoint: string;
    readonly registration_endpoint: string;
  }>(
    await fetch(new URL("/.well-known/oauth-authorization-server", issuer)),
    "mintBearer: authorization-server metadata",
  );

  const redirectUri = "http://127.0.0.1:9/callback";
  const registered = await jsonFrom<{ readonly client_id: string }>(
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
    }),
    "mintBearer: dynamic client registration",
  );

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

  const token = await jsonFrom<TokenResponse>(
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
    }),
    "mintBearer: token exchange",
  );
  if (!token.access_token) throw new Error("mintBearer: token exchange returned no token");
  return token.access_token;
};

export const makeMcpSurface = (target: Target, runDir?: string): McpSurface => ({
  url: target.mcpUrl,
  mintBearer: (email) => Effect.promise(() => mintBearerFlow(target, email)),
  session: (identity, options) => {
    const mcpUrl = options?.url ?? target.mcpUrl;
    if (runDir) installTraceparentFetch(mcpUrl, runDir);
    // mcporter caches OAuth tokens (and the DCR client) per server NAME, so a
    // constant name would let a later session reuse an earlier identity's token
    // — landing in the wrong org. A unique name per session keeps each
    // identity's OAuth isolated. The traceparent ledger keys off the URL, not
    // this name, so it is unaffected.
    const serverName = `${target.name}-${randomUUID().slice(0, 8)}`;
    // `browser` mode is selected per the ecosystem convention — an
    // `?elicitation_mode=` query on the MCP endpoint — so a paused execution
    // yields an approvalUrl instead of letting the model resume inline.
    const sessionUrl = options?.elicitationMode
      ? `${mcpUrl}?elicitation_mode=${options.elicitationMode}`
      : mcpUrl;

    if (target.name === "cloudflare") {
      let clientPromise: Promise<Client> | undefined;
      const client = () => {
        if (!clientPromise) {
          clientPromise = (async () => {
            const directClient = new Client(
              { name: serverName, version: "1.0.0" },
              { capabilities: {} },
            );
            const transport = new StreamableHTTPClientTransport(new URL(sessionUrl), {
              requestInit: { headers: identity.headers ?? {} },
            });
            await directClient.connect(transport);
            return directClient;
          })();
        }
        return clientPromise;
      };

      const listTools = () =>
        Effect.promise(async () => {
          const listed = await (await client()).listTools();
          return listed.tools.map((tool) => tool.name);
        });

      const call = (name: string, args: Record<string, unknown> = {}) =>
        Effect.promise(async (): Promise<McpCallResult> => {
          const raw = await (await client()).callTool({ name, arguments: args });
          const isError = Boolean((raw as { isError?: boolean })?.isError);
          return { raw, text: textOf(raw), ok: !isError };
        });

      return {
        listTools,
        describeTools: () =>
          Effect.promise(async (): Promise<ReadonlyArray<McpToolDef>> => {
            const listed = await (await client()).listTools();
            return listed.tools.map((tool) => ({
              name: tool.name,
              description: tool.description ?? "",
            }));
          }),
        call,
        approvePaused: (text, content = {}) =>
          Effect.suspend(() => {
            const match = /\bexecutionId:\s*(\S+)/.exec(text);
            if (!match)
              return Effect.die(new Error("approvePaused: executionId not found in text"));
            return call("resume", {
              executionId: match[1],
              action: "accept",
              content: JSON.stringify(content),
            });
          }),
        awaitResume: (executionId) => call("resume", { executionId }),
      };
    }

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
            mcpServers: { [serverName]: { url: sessionUrl } },
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
      // No action argument: in browser mode `resume` blocks until the human's
      // decision arrives via the console, then returns the resumed result.
      awaitResume: (executionId) => call("resume", { executionId }),
    };
  },
});
