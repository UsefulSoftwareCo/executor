// ---------------------------------------------------------------------------
// @executor-js/sdk/host-internal — host-composition seams that live in the SDK
// only because the SDK's own internals share their implementation.
//
// This entry is NOT part of the plugin-author contract (the root barrel). It
// exists so the host layer (`@executor-js/api/server`) can reach SDK-resident
// host machinery without that machinery polluting the plugin-author surface:
//
//   - `makeHostedHttpClientLayer` / `makeHostedFetch` /
//     `HostedOutboundRequestBlocked`: the hosted HTTP client builder plus the
//     guarded Fetch API adapter for libraries that require fetch. The shared
//     outbound URL guard is consumed by `createExecutor`'s built-in `fetch` tool
//     (the SSRF guard), which is why the module stays in the SDK rather than
//     moving wholesale to the host.
//   - `createExecutorFumaDb` + its types: the pure, driver-agnostic FumaDB
//     assembly. It stays in the SDK because the SDK's own sqlite test backend
//     builds its handle with it; the host layer re-exports it (and pairs it
//     with the `DbProvider` Effect seam) from `@executor-js/api/server`.
//   - `assertSupportedOAuthEndpointUrl` / `OAUTH2_DEFAULT_TIMEOUT_MS`: the OAuth
//     endpoint SSRF guard + default fetch timeout. The SDK's own OAuth flow uses
//     them; the host's connection-identity handler reuses the same guard/timeout
//     when fetching OIDC userinfo, so they surface here (not the plugin barrel).
// ---------------------------------------------------------------------------

export {
  HostedOutboundRequestBlocked,
  makeHostedFetch,
  makeHostedHttpClientLayer,
  type HostedHttpClientOptions,
} from "./hosted-http-client";

export { OAUTH2_DEFAULT_TIMEOUT_MS, assertSupportedOAuthEndpointUrl } from "./oauth-helpers";

export {
  createExecutorFumaDb,
  type CreateExecutorFumaDbOptions,
  type ExecutorDbHandle,
  type ExecutorDbProvider,
  type ExecutorFumaDb,
  type ExecutorFumaSchema,
} from "./executor-fuma-db";
