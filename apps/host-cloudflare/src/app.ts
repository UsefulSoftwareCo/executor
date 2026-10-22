import { Effect } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

import {
  dbProviderLayer,
  ExecutorApp,
  textFailureStrategy,
  type DelegatedExecutionResumerShape,
} from "@executor-js/api/server";
import { Subject } from "@executor-js/sdk";

import { loadConfig, type CloudflareEnv } from "./config";
import { makeCloudflarePlugins } from "./plugins";
import { createD1ExecutorDb } from "./db/d1";
import { makeCloudflareDelegatingIdentityLayer } from "./auth/identity";
import {
  CloudflareCodeExecutorProvider,
  makeCloudflareExecutionStackLayer,
  makeCloudflareHostConfig,
  makeCloudflarePluginsProvider,
  makeExecutionStack,
} from "./execution";
import { ErrorCaptureLive } from "./observability";
import {
  cloudflareAccountMiddleware,
  cloudflareDelegationProvider,
} from "./account/account-provider";
import { makeCloudflareDelegationService } from "./auth/delegation";
import { makeCloudflareApprovalHandler } from "./mcp";
import { makeCloudflareMcpAgentHandler } from "./mcp/agent-handler";
import { preloadQuickJs } from "./quickjs";
import { hasRecentAccessAuthentication } from "./auth/cloudflare-access";
import { makeVerifiedHumanSubjectRegistry } from "@executor-js/sdk";

/**
 * Rebuild the original grant-scoped engine when an HTTP approval arrives after
 * the request that paused it has ended. The browser approver is checked from
 * the live AuthContext by the shared handler; this host callback additionally
 * requires the target to remain verified and resolves the immutable binding
 * before it consumes or executes the pending record.
 */
const makeCloudflareDelegatedExecutionResumer = (
  dbHandle: Awaited<ReturnType<typeof createD1ExecutorDb>>,
  config: ReturnType<typeof loadConfig>,
  verifiedHumans: ReturnType<typeof makeVerifiedHumanSubjectRegistry>,
): DelegatedExecutionResumerShape => {
  const serviceFor = () =>
    makeCloudflareDelegationService(dbHandle, config, {
      isVerifiedHuman: (subject) =>
        verifiedHumans.isVerifiedHuman({
          tenant: config.organizationId,
          subject: String(subject),
        }),
      // The machine assertion is gone by the time a browser approves a
      // durable pause. The immutable binding and the target tombstone are the
      // remaining durable checks; the original Access service-token tuple is
      // still carried through the rebuilt delegated context.
      isCurrentlyAuthorized: (grant) =>
        verifiedHumans.isVerifiedHuman({
          tenant: config.organizationId,
          subject: String(grant.effectiveSubject),
        }),
      isManagementAuthorized: (actorSubject, targetSubject) =>
        Effect.gen(function* () {
          const actor = yield* verifiedHumans.isVerifiedHuman({
            tenant: config.organizationId,
            subject: String(actorSubject),
          });
          if (!actor) return false;
          if (targetSubject === undefined) return true;
          return yield* verifiedHumans.isVerifiedHuman({
            tenant: config.organizationId,
            subject: String(targetSubject),
          });
        }),
      verifyProof: () => Effect.succeed(false),
    });

  const canApprove = (input: Parameters<DelegatedExecutionResumerShape["authorize"]>[0]) =>
    input.approver.accountId !== null &&
    input.approver.organizationId === config.organizationId &&
    String(input.binding.tenant) === config.organizationId &&
    (String(input.binding.effectiveSubject) === input.approver.accountId ||
      input.approver.roles?.includes("admin") === true);

  return {
    authorize: (input) =>
      Effect.gen(function* () {
        if (!canApprove(input)) return false;
        yield* serviceFor().resolveBinding(input.binding);
        return true;
      }),
    resume: (input) =>
      Effect.gen(function* () {
        if (!canApprove(input)) return null;
        const service = serviceFor();
        const grant = yield* service.resolveBinding(input.binding);
        yield* service.audit({
          grantId: grant.grantId,
          credentialId: grant.credentialId,
          actorSubject: Subject.make(input.approver.accountId ?? ""),
          effectiveSubject: grant.effectiveSubject,
          action: "approval",
          outcome: "allowed",
          executionId: input.executionId,
        });
        const stack = yield* makeExecutionStack<ReturnType<typeof makeCloudflarePlugins>>(
          String(grant.effectiveSubject),
          String(grant.tenant),
          config.organizationName,
          { delegation: grant },
        ).pipe(Effect.provide(makeCloudflareExecutionStackLayer(config, dbHandle)));
        return yield* stack.engine
          .executeWithPause(input.code, { autoApprove: true })
          .pipe(Effect.ensuring(stack.engine.shutdown));
      }),
  };
};

// ===========================================================================
// The Cloudflare host, as ONE `ExecutorApp.make` call: the 4th app alongside
// cloud / self-host / local, differing only by the injected Layers.
//
// The whole scenario in 60 seconds: Cloudflare Access is the identity (validate
// the Cf-Access-Jwt-Assertion JWT, no Better Auth, no WorkOS, no app login),
// D1 is the SQLite store (same FumaDB assembly as self-host), QuickJS is the
// in-process code substrate, no billing, single-tenant. `diff` against
// host-selfhost/src/app.ts is three injected Layers: identity, db, plugins/config.
//
// Built per isolate (async) so the D1 schema bring-up happens once at first
// fetch; `env` arrives with that fetch (a Worker has no module-scope bindings),
// so the providers close over it instead of reading process.env.
// ===========================================================================

export const makeCloudflareApp = async (env: CloudflareEnv) => {
  const config = loadConfig(env);
  const plugins = makeCloudflarePlugins(config.secretKey);

  // Load the Workers-compatible (WASM-inlined) QuickJS variant before any
  // executor is built, the default variant cannot fetch its .wasm on Workers.
  await preloadQuickJs();

  // Open and idempotently bring up the D1 schema once. This is the long-lived
  // handle the per-request scoped executor reads through the DbProvider seam.
  const dbHandle = await createD1ExecutorDb(env.DB, env.BLOBS);
  const verifiedHumans = makeVerifiedHumanSubjectRegistry(dbHandle.db);
  const delegatedExecutionResumer = makeCloudflareDelegatedExecutionResumer(
    dbHandle,
    config,
    verifiedHumans,
  );
  const identityLayer = makeCloudflareDelegatingIdentityLayer(dbHandle, config, verifiedHumans, {
    onVerifiedHuman: (claims, principal, request) => {
      const browserOrigin = request.headers.get("origin");
      const requestOrigin = new URL(request.url).origin;
      const expectedOrigin = config.webBaseUrl ?? requestOrigin;
      // Only a same-origin browser request with a recent IdP authentication
      // event can establish the durable human registry status. `iat` is not a
      // login signal, and service-token assertions never reach this callback.
      if (
        browserOrigin !== expectedOrigin ||
        requestOrigin !== expectedOrigin ||
        !hasRecentAccessAuthentication(
          claims,
          config.delegatedRecentAuthMaxAgeMs,
          Date.now(),
          config.delegatedRecentAuthClaim,
        )
      ) {
        return Effect.void;
      }
      return verifiedHumans
        .markVerifiedHuman({ tenant: config.organizationId, subject: principal.accountId })
        .pipe(Effect.catch(() => Effect.void));
    },
  });
  const mcpAgentHandler = makeCloudflareMcpAgentHandler(config);
  const approvalHandler = makeCloudflareApprovalHandler(config, env);

  const { appLayer, toWebHandler } = ExecutorApp.make({
    plugins,
    providers: {
      identity: identityLayer,
      db: dbProviderLayer(Effect.succeed(dbHandle)),
      engine: { codeExecutor: CloudflareCodeExecutorProvider },
      plugins: {
        provider: makeCloudflarePluginsProvider(config),
        config: makeCloudflareHostConfig(config),
      },
      errorCapture: ErrorCaptureLive,
      // The account API (`/api/account/*`) backs the shared multiplayer shell's
      // auth context; `me` reflects the Access principal. Members/keys are
      // Access-managed, so the rest of the surface is stubbed.
      account: cloudflareAccountMiddleware(config),
      delegation: cloudflareDelegationProvider(dbHandle, config, verifiedHumans),
    },
    delegatedExecutionResumer,
    extensions: {
      routes: [
        // Browser approval of paused MCP executions: the console resume page
        // reads paused detail (GET) and records the decision (POST .../resume),
        // Access-gated, routed to the owning session's Durable Object.
        HttpRouter.add("*", "/api/mcp-sessions/*", HttpEffect.fromWebHandler(approvalHandler)),
      ],
    },
    config: { mountPrefix: "/api", failure: textFailureStrategy },
    boot: identityLayer,
  });

  return { appLayer, toWebHandler, mcpAgentHandler };
};
