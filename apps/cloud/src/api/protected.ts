// Production wiring for the protected API: the per-request HttpRouter
// middleware that resolves identity, builds the executor/engine, and provides
// `AuthContext` + the execution-stack services to handlers.

import { Effect, Layer } from "effect";

import {
  IdentityProvider,
  makeExecutionStackMiddleware,
  requestScopedMiddleware,
  RouterConfigLive,
  type IdentityFailure,
} from "@executor-js/api/server";

import { cloudPlugins, type CloudPlugins } from "../plugins";
import { ApiKeyService } from "../auth/api-keys";
import { UserStoreService } from "../auth/context";
import { cloudIdentityFailureStrategy, workosIdentityLayer } from "../auth/workos-auth-provider";
import { AutumnService } from "../extensions/billing/service";
import { DbService } from "../db/db";
import { CoreSharedServices } from "../auth/workos";
import { CloudMeteredExecutionStackLayer } from "../engine/execution-stack-metered";
import { ProtectedCloudApiLive, RequestScopedServicesLive } from "./layers";

// Re-exported for `protected-api-key-auth.node.test.ts`, which asserts the
// per-path principal + error codes the folded resolver still produces.
export {
  resolveApiKeyPrincipal,
  resolveSessionPrincipal,
  resolveProtectedPrincipal,
} from "../auth/workos-auth-provider";

// One `HttpRouter` middleware that:
//   1. resolves identity via the NEUTRAL `IdentityProvider` (api-key BEATS sealed
//      session, decided INSIDE cloud's `workosIdentityLayer`), verifying live org
//      membership,
//   2. builds the per-request executor + engine,
//   3. provides `AuthContext` + the execution-stack services to the handler.
//
// Replaces both the old outer `Effect.gen` in this file (which did its own
// WorkOS lookup) and the per-route `OrgAuth` HttpApiMiddleware (which did
// a second one).
//
// The shared `makeExecutionStackMiddleware` (P5) owns the body; cloud injects:
//   - the neutral `IdentityProvider`  -> the identity seam. Cloud's
//                                     `workosIdentityLayer` provides this tag; it
//                                     reads the per-request `UserStoreService`, so
//                                     it is built PER REQUEST in the DB combine
//                                     below (NOT captured at boot).
//   - `cloudIdentityFailureStrategy` -> renders the shared identity errors as
//                                     cloud's exact `{ error, code }` JSON at
//                                     status 401/403/503 (byte-identical).
//   - `cloudPlugins` + `CloudMeteredExecutionStackLayer` — the HTTP executor
//                                     plane meters here; the MCP session DO uses
//                                     the same metered stack (with its own
//                                     `AutumnService.Default`), so both planes
//                                     bill executions.
//
// Only `AutumnService` is captured at boot; `IdentityProvider` + `DbService` +
// `UserStoreService` stay residual and are supplied per request by the combined
// `requestScopedMiddleware` (so the postgres.js socket — and the identity layer
// that reads it — live in the request fiber's scope, satisfying Cloudflare
// Workers' I/O isolation).
const ExecutionStackMiddleware = makeExecutionStackMiddleware<
  CloudPlugins,
  IdentityFailure,
  IdentityProvider,
  AutumnService | DbService,
  never,
  // Capture only the boot-scoped `AutumnService`; `IdentityProvider` + `DbService`
  // + `UserStoreService` stay residual and flow through the per-request DB combine.
  AutumnService
>({
  plugins: cloudPlugins,
  authenticate: (request) =>
    IdentityProvider.asEffect().pipe(Effect.flatMap((provider) => provider.authenticate(request))),
  strategy: cloudIdentityFailureStrategy,
  stackLayer: CloudMeteredExecutionStackLayer,
});

// `rsLive` is the per-request DB layer. `requestScopedLive` folds the neutral
// `IdentityProvider` (cloud's `workosIdentityLayer`, which reads the per-request
// `UserStoreService` from `rsLive` and the boot `WorkOSClient` / `ApiKeyService`
// residually) ON TOP of it, so the identity layer is rebuilt per request in the
// same request-fiber scope as the postgres.js socket it reads — satisfying
// Cloudflare Workers' I/O isolation. Combining it into the auth middleware
// collapses `requires: IdentityProvider | DbService | UserStoreService` to the
// boot-only `WorkOSClient | ApiKeyService` (so `.layer` is a real Layer instead
// of the "Need to combine" sentinel). Exposed as a factory so tests can swap in a
// counting fake — see `apps/cloud/src/api.request-scope.node.test.ts`.
//
// `AutumnService` is provided HERE — the billing service is scoped to the
// executor plane that meters, not to the neutral boot core. (`/autumn`, the
// account seat-gate, and the createOrganization free-limit gate each provide it
// where they run.)
export const makeProtectedApiLive = (rsLive: Layer.Layer<DbService | UserStoreService>) => {
  // The neutral `IdentityProvider`, built per request: it reads `UserStoreService`
  // from `rsLive` and the WorkOS control plane (`WorkOSClient` + `ApiKeyService`,
  // stateless config — no per-request I/O socket) for the org-resolution path.
  // `orDie` because a WorkOS config error is unrecoverable.
  const identityLive = workosIdentityLayer.pipe(
    Layer.provide(rsLive),
    Layer.provide(ApiKeyService.WorkOS.pipe(Layer.provide(CoreSharedServices))),
    Layer.provide(CoreSharedServices),
    // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: a boot-time WorkOS misconfiguration is unrecoverable
    Layer.orDie,
  );
  // The per-request layer the combine rebuilds in the request fiber's scope: the
  // postgres socket (`rsLive`) PLUS the identity layer that reads it. Combining it
  // into the auth middleware collapses `requires: IdentityProvider | DbService |
  // UserStoreService` to `never` (so `.layer` is a real Layer instead of the "Need
  // to combine" sentinel) AND keeps the socket request-scoped. Exposed as a
  // factory so tests can swap in a counting fake — see
  // `apps/cloud/src/api.request-scope.node.test.ts`.
  const requestScopedLive = rsLive.pipe(Layer.provideMerge(identityLive));
  const protectedMiddleware = ExecutionStackMiddleware.combine(
    requestScopedMiddleware(requestScopedLive),
  ).layer;
  return ProtectedCloudApiLive.pipe(
    Layer.provide(protectedMiddleware),
    Layer.provideMerge(AutumnService.Default),
    Layer.provideMerge(RouterConfigLive),
  );
};

export const ProtectedApiLive = makeProtectedApiLive(RequestScopedServicesLive);
