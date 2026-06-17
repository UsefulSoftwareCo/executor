import { makeCloudflareApp } from "./app";
import type { CloudflareEnv } from "./config";
import { stripMcpOrgSegment } from "./mcp/org-path";

// The MCP session Durable Object class, bound as `MCP_SESSION` in wrangler.jsonc.
// Must be exported at the Worker entry module scope for the runtime to find it.
export { McpSessionDO } from "./mcp";

// ---------------------------------------------------------------------------
// The Worker fetch entry. `ExecutorApp.make`'s `toWebHandler()` produces a
// `(Request) => Promise<Response>` — exactly a Worker handler — so the entry is
// thin: build the app ONCE per isolate (memoized; the build runs the D1 schema
// bring-up), then forward every request to its handler. `env` (the D1 binding +
// Access vars) arrives with the request and is captured at build time.
// ---------------------------------------------------------------------------

let handlerPromise: Promise<(request: Request) => Promise<Response>> | null = null;

const resolveHandler = (env: CloudflareEnv): Promise<(request: Request) => Promise<Response>> => {
  if (!handlerPromise) {
    handlerPromise = makeCloudflareApp(env).then(({ toWebHandler }) => toWebHandler().handler);
  }
  return handlerPromise;
};

const prepareRequest = (request: Request): Request => {
  const url = new URL(request.url);
  const rewritten = stripMcpOrgSegment(url.pathname);
  if (rewritten === null) return request;
  url.pathname = rewritten;
  return new Request(url, request);
};

export default {
  fetch: async (request: Request, env: CloudflareEnv): Promise<Response> => {
    const serve = await resolveHandler(env);
    return serve(prepareRequest(request));
  },
};
