import { makeCloudflareApp } from "./app";
import type { CloudflareEnv } from "./config";

// The MCP session Durable Object class, bound as `MCP_SESSION` in wrangler.jsonc.
// Must be exported at the Worker entry module scope for the runtime to find it.
export { McpSessionDO } from "./mcp";

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

export default {
  fetch: async (request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> => {
    const serve = await resolveHandler(env);
    if (new URL(request.url).pathname === "/mcp") {
      return serve.mcp(request, env, ctx);
    }
    return serve.app(request);
  },
};
