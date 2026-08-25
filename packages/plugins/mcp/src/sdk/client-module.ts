// ---------------------------------------------------------------------------
// Lazy loader for `@modelcontextprotocol/client`. Evaluating the client
// barrel costs ~11MB of heap and tens of ms of module eval (transports, jose,
// eventsource, its bundled protocol schemas) — per ISOLATE, at startup, when
// imported statically into a Cloudflare Worker bundle. Only code paths that
// actually dial an outbound MCP server need any of it, so the module graph is
// loaded on first connect and memoized; isolates that never touch outbound
// MCP never pay (2026-08-25 latency incident: per-isolate baseline memory is
// what collapses isolate reuse).
//
// `mcpClientSdkIfLoaded` exists for synchronous error classification
// (`SdkHttpError.isInstance` etc. in http-status.ts / invoke.ts): every error
// of those classes is CONSTRUCTED by this module, so if it was never loaded
// the cause under inspection cannot be one of them and `undefined` is a
// correct, not a lossy, answer.
// ---------------------------------------------------------------------------

export type McpClientModule = typeof import("@modelcontextprotocol/client");
export type McpClientValidatorsModule =
  typeof import("@modelcontextprotocol/client/validators/cf-worker");

export type McpClientSdk = {
  readonly client: McpClientModule;
  readonly validators: McpClientValidatorsModule;
};

let loaded: McpClientSdk | undefined;
let loading: Promise<McpClientSdk> | undefined;

export const loadMcpClientSdk = (): Promise<McpClientSdk> =>
  (loading ??= Promise.all([
    import("@modelcontextprotocol/client"),
    import("@modelcontextprotocol/client/validators/cf-worker"),
  ]).then(([client, validators]) => {
    loaded = { client, validators };
    return loaded;
  }));

export const mcpClientSdkIfLoaded = (): McpClientSdk | undefined => loaded;
