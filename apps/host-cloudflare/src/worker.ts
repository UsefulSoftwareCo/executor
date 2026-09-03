import { mcpResourceFromPathname } from "@executor-js/host-mcp";

import { makeCloudflareApp } from "./app";
import {
  cloudflareAccessConfigErrorMessage,
  missingCloudflareAccessVars,
  type CloudflareEnv,
} from "./config";

// The MCP Durable Object classes, bound in wrangler.jsonc. They must be exported
// at the Worker entry module scope for the runtime to find them.
export { McpExecutionOwnerDirectoryDO, McpSessionDO } from "./mcp";

// ---------------------------------------------------------------------------
// The Worker fetch entry. Most requests go to `ExecutorApp.make`'s Effect web
// handler. `/mcp` and its scoped sub-resources stay at this edge boundary
// because `McpAgent.serve()` needs the Cloudflare `ExecutionContext` to pass
// authenticated session props into the hibernatable Durable Object bridge.
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

const accessConfigErrorResponse = (missingVars: readonly string[]): Response =>
  new Response(`${cloudflareAccessConfigErrorMessage(missingVars)}\n`, {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });

export default {
  fetch: async (request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> => {
    const missingAccessVars = missingCloudflareAccessVars(env);
    if (missingAccessVars.length > 0) {
      return accessConfigErrorResponse(missingAccessVars);
    }

    const serve = await resolveHandler(env);
    if (mcpResourceFromPathname(new URL(request.url).pathname) !== null) {
      return serve.mcp(request, env, ctx);
    }
    return serve.app(request);
  },
};
