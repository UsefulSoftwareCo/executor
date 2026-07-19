import { decodeOAuthCallbackState } from "@executor-js/sdk/shared";

import { makeCloudflareApp } from "./app";
import type { CloudflareEnv } from "./config";

// The MCP Durable Object classes, bound in wrangler.jsonc. They must be exported
// at the Worker entry module scope for the runtime to find them.
export { McpExecutionOwnerDirectoryDO, McpSessionDO } from "./mcp";

// ---------------------------------------------------------------------------
// The Worker fetch entry. Most requests go to `ExecutorApp.make`'s Effect web
// handler. `/mcp` stays at this edge boundary because `McpAgent.serve()` needs
// the Cloudflare `ExecutionContext` to pass authenticated session props into the
// hibernatable Durable Object bridge.
// ---------------------------------------------------------------------------

let handlerPromise: Promise<{
  readonly app: (request: Request) => Promise<Response>;
  readonly mcp: (request: Request, env: CloudflareEnv, ctx: ExecutionContext) => Promise<Response>;
}> | null = null;

const resolveHandler = (env: CloudflareEnv) => {
  if (!handlerPromise) {
    handlerPromise = makeCloudflareApp(env).then(({ toWebHandler, mcpAgentHandler }) => ({
      app: toWebHandler().handler,
      mcp: mcpAgentHandler,
    }));
  }
  return handlerPromise;
};

const OAUTH_CALLBACK_PATH = "/api/oauth/callback";

const normalizeOAuthCallbackState = (request: Request): Request => {
  if (request.method !== "GET" && request.method !== "HEAD") return request;

  const url = new URL(request.url);
  if (url.pathname !== OAUTH_CALLBACK_PATH) return request;

  const callbackState = decodeOAuthCallbackState(url.searchParams.get("state"));
  if (callbackState === null) return request;

  // Executor persists the raw random state but sends providers an encoded state
  // containing the org slug. Cloud's host middleware unwraps that before the
  // shared OAuth handler runs; the single-tenant Cloudflare host needs the same
  // normalization or OAuth callbacks cannot find their pending session.
  url.searchParams.set("state", callbackState.state);
  return new Request(url, request);
};

export default {
  fetch: async (request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> => {
    const serve = await resolveHandler(env);
    if (new URL(request.url).pathname === "/mcp") {
      return serve.mcp(request, env, ctx);
    }
    return serve.app(normalizeOAuthCallbackState(request));
  },
};
