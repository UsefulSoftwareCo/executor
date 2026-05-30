// ---------------------------------------------------------------------------
// @executor-js/sdk/host-internal — host-composition seams that live in the SDK
// only because the SDK's own internals share their implementation.
//
// This entry is NOT part of the plugin-author contract (the root barrel). It
// exists so the host layer (`@executor-js/api/server`) can reach SDK-resident
// host machinery without that machinery polluting the plugin-author surface:
//
//   - `makeHostedHttpClientLayer` / `HostedOutboundRequestBlocked`: the hosted
//     HTTP client builder. `validateHostedOutboundUrl` is consumed by
//     `createExecutor`'s built-in `fetch` tool (the SSRF guard), which is why
//     the module stays in the SDK rather than moving wholesale to the host.
//   - `createExecutorFumaDb` + its types: the pure, driver-agnostic FumaDB
//     assembly. It stays in the SDK because the SDK's own sqlite test backend
//     builds its handle with it; the host layer re-exports it (and pairs it
//     with the `DbProvider` Effect seam) from `@executor-js/api/server`.
// ---------------------------------------------------------------------------

export {
  HostedOutboundRequestBlocked,
  makeHostedHttpClientLayer,
  type HostedHttpClientOptions,
} from "./hosted-http-client";

export {
  createExecutorFumaDb,
  type CreateExecutorFumaDbOptions,
  type ExecutorDbHandle,
  type ExecutorDbProvider,
  type ExecutorFumaDb,
  type ExecutorFumaSchema,
} from "./executor-fuma-db";
