// Production wiring for the protected API: the per-request HttpRouter
// middleware that resolves identity, builds the executor/engine, and provides
// `AuthContext` + the execution-stack services to handlers.

import { Context, Effect, Layer, Option } from "effect";
import { env } from "cloudflare:workers";

import {
  collectTables,
  DelegatedExecutionResumer as DelegatedExecutionResumerTag,
  IdentityProvider,
  makeExecutionStack,
  makeExecutionStackMiddleware,
  requestScopedMiddleware,
  RouterConfigLive,
  type IdentityFailure,
  MemberDirectory,
  type DelegatedExecutionResumerShape,
} from "@executor-js/api/server";

import { cloudPlugins, type CloudPlugins } from "../plugins";
import { ApiKeyService } from "../auth/api-keys";
import { UserStoreService } from "../auth/context";
import { WorkOsMirror } from "../auth/workos-mirror";
import { cloudIdentityFailureStrategy, workosIdentityLayer } from "../auth/workos-auth-provider";
import { AutumnService } from "../extensions/billing/service";
import { DbService } from "../db/db";
import { CoreSharedServices } from "../auth/workos";
import { CloudMeteredExecutionStackLayer } from "../engine/execution-stack-metered";
import { CLOUD_NAMESPACE, createDrizzleFumaDb } from "../db/fuma";
import { makeCloudDelegationService } from "../auth/delegation";
import { Subject } from "@executor-js/sdk";
import { ProtectedCloudApiLive, RequestScopedServicesLive } from "./layers";

/** Request-local handles used by the durable approval resumer. Keeping them
 * behind one cloud-local service gives the request-scoped resumer layer one
 * exact request dependency to satisfy while retaining the database scope. */
class DelegationResumerScope extends Context.Service<
  DelegationResumerScope,
  { readonly db: DbService["Service"]; readonly directory: MemberDirectory["Service"] }
>()("@executor-js/cloud/DelegationResumerScope") {}

/**
 * Durable delegated approvals run on a fresh request engine. The approver's
 * ordinary engine is intentionally never reused: resolveBinding reconstructs
 * the immutable grant, the audit actor is the verified human, and the rebuilt
 * engine carries the original delegation context through dispatch.
 *
 * Resumer creation is a request-scoped layer below. Missing optional boot
 * services produce the null reference value, so legacy compositions fail
 * closed without borrowing an approver's ordinary engine.
 */
const makeCloudDelegatedResumer = (input: {
  readonly db: DbService["Service"];
  readonly directory: MemberDirectory["Service"];
  readonly apiKeys: ApiKeyService["Service"];
  readonly autumn: AutumnService["Service"];
}): DelegatedExecutionResumerShape => {
  const fuma = createDrizzleFumaDb({
    db: input.db.db,
    tables: collectTables(),
    namespace: CLOUD_NAMESPACE,
    provider: "postgresql",
  });
  const serviceFor = (tenant: string) =>
    makeCloudDelegationService({
      db: fuma.db,
      tenant,
      directory: input.directory,
      apiKeys: input.apiKeys,
      issuanceEnabled: env.DELEGATED_ISSUANCE_ENABLED === "true",
    });
  return {
    authorize: (request) =>
      Effect.gen(function* () {
        const service = serviceFor(String(request.binding.tenant));
        const target = yield* input.directory.membership(
          String(request.approver.accountId),
          String(request.binding.tenant),
          ["active"],
        );
        if (!target) return false;
        if (
          String(request.approver.accountId) !== String(request.binding.effectiveSubject) &&
          target.role !== "admin"
        )
          return false;
        yield* service.resolveBinding(request.binding);
        return true;
      }),
    resume: (request) =>
      Effect.gen(function* () {
        if (request.approver.accountId === null) return null;
        const service = serviceFor(String(request.binding.tenant));
        const grant = yield* service.resolveBinding(request.binding);
        yield* service.audit({
          grantId: grant.grantId,
          credentialId: grant.credentialId,
          actorSubject: Subject.make(request.approver.accountId),
          effectiveSubject: grant.effectiveSubject,
          action: "approval",
          outcome: "allowed",
          executionId: request.executionId,
        });
        const stack = yield* makeExecutionStack<CloudPlugins>(
          String(grant.effectiveSubject),
          String(grant.tenant),
          String(grant.tenant),
          { delegation: grant },
        ).pipe(
          Effect.provide(CloudMeteredExecutionStackLayer),
          Effect.provideService(DbService, input.db),
          Effect.provideService(AutumnService, input.autumn),
        );
        return yield* stack.engine
          .executeWithPause(request.code, { autoApprove: true })
          .pipe(Effect.ensuring(stack.engine.shutdown));
      }),
  };
};

// Re-exported for `protected-api-key-auth.node.test.ts`, which asserts the
// per-path principal + error codes the folded resolver still produces.
export {
  resolveApiKeyPrincipal,
  resolveSessionPrincipal,
  resolveProtectedPrincipal,
  resolveProtectedPrincipalWithDelegation,
} from "../auth/workos-auth-provider";

// One `HttpRouter` middleware that:
//   1. resolves identity via the NEUTRAL `IdentityProvider` (api-key BEATS sealed
//      session, decided INSIDE cloud's `workosIdentityLayer`), verifying org
//      membership against the local mirror,
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
export const makeProtectedApiLive = (
  rsLive: Layer.Layer<DbService | UserStoreService | MemberDirectory | WorkOsMirror>,
) => {
  // The neutral `IdentityProvider`, built per request: it reads `UserStoreService`
  // + `MemberDirectory` from `rsLive` and the WorkOS control plane (`WorkOSClient` + `ApiKeyService`,
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
  const resumerScopeLive = Layer.effect(
    DelegationResumerScope,
    Effect.gen(function* () {
      return {
        db: yield* DbService,
        directory: yield* MemberDirectory,
      };
    }),
  );
  const requestScopedWithResumerScope = Layer.merge(
    requestScopedLive,
    resumerScopeLive.pipe(Layer.provide(requestScopedLive)),
  );
  const delegatedResumerLive = Layer.effect(
    DelegatedExecutionResumerTag,
    Effect.gen(function* () {
      const apiKeys = yield* Effect.serviceOption(ApiKeyService);
      const autumn = yield* Effect.serviceOption(AutumnService);
      const scope = yield* Effect.serviceOption(DelegationResumerScope);
      if (Option.isNone(scope) || Option.isNone(apiKeys) || Option.isNone(autumn)) return null;
      return makeCloudDelegatedResumer({
        db: scope.value.db,
        directory: scope.value.directory,
        apiKeys: apiKeys.value,
        autumn: autumn.value,
      });
    }),
  );
  const requestScopedWithResumer = Layer.merge(
    requestScopedWithResumerScope,
    delegatedResumerLive.pipe(Layer.provide(requestScopedWithResumerScope)),
  );
  const protectedMiddleware = ExecutionStackMiddleware.combine(
    requestScopedMiddleware(requestScopedWithResumer),
  );
  const protectedApiMiddleware = protectedMiddleware.layer;
  return ProtectedCloudApiLive.pipe(
    Layer.provide(protectedApiMiddleware),
    Layer.provideMerge(AutumnService.Default),
    Layer.provideMerge(RouterConfigLive),
  );
};

export const ProtectedApiLive = makeProtectedApiLive(RequestScopedServicesLive);
