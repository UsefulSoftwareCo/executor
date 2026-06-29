import { Layer } from "effect";

import { accountProviderMiddlewareLayer } from "@executor-js/api/server";

import { BetterAuth, type BetterAuthHandle } from "../auth/better-auth";
import { betterAuthAccountProvider } from "./better-auth-account-provider";

// ---------------------------------------------------------------------------
// Self-host account seam: the per-request `AccountProvider` middleware backed by
// Better Auth. `ExecutorApp.make` mounts the shared, provider-neutral
// `AccountHandlers` behind it under the `/api` prefix (same prefixed router as
// the plugin API). The provider does its OWN auth (each handler resolves the
// session via the request headers), so it is NOT wrapped by the execution-stack
// middleware — account requests never build a code executor.
//
// The handlers `yield* AccountProvider` at request time; providing it through a
// router middleware (like the plugin API's ExecutionStackMiddleware provides
// ExecutorService) satisfies the requirement without leaking into the app
// layer's output. The Better Auth `AccountProvider` is self-contained, so it
// goes through the common-case `accountProviderMiddlewareLayer` (wraps it in
// `requestScopedMiddleware`).
// ---------------------------------------------------------------------------

export const selfHostAccountMiddleware = (betterAuth: BetterAuthHandle) =>
  accountProviderMiddlewareLayer(
    betterAuthAccountProvider.pipe(Layer.provide(Layer.succeed(BetterAuth)(betterAuth))),
  );
