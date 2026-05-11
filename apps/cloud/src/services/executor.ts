// ---------------------------------------------------------------------------
// Cloud executor — stateless, per-request, new SDK shape
// ---------------------------------------------------------------------------
//
// Each invocation of `createScopedExecutor` runs inside a request-scoped
// Effect and yields a fresh executor bound to the current DbService's
// per-request postgres.js client. Cloudflare Workers + Hyperdrive demand
// fresh connections per request, so "build once" means "once per request"
// here.

import { Effect } from "effect";

import {
  Scope,
  ScopeId,
  collectSchemas,
  createExecutor,
  makeHostedHttpClientLayer,
} from "@executor-js/sdk";
import { makePostgresAdapter, makePostgresBlobStore } from "@executor-js/storage-postgres";

import { env } from "cloudflare:workers";
import executorConfig from "../../executor.config";
import { DbService } from "./db";

// ---------------------------------------------------------------------------
// Plugin list lives in `executor.config.ts` — that file is the single
// source of truth, also consumed by the schema-gen CLI and the test
// harness. Per-request runtime values (WorkOS credentials from the
// Worker env) are passed through the factory's `deps` parameter.
// ---------------------------------------------------------------------------

export type CloudPlugins = ReturnType<typeof executorConfig.plugins>;

const orgPlugins = (): CloudPlugins =>
  executorConfig.plugins({
    workosCredentials: {
      apiKey: env.WORKOS_API_KEY,
      clientId: env.WORKOS_CLIENT_ID,
    },
  });

// ---------------------------------------------------------------------------
// Create a fresh executor for a (user, org) pair (stateless, per-request).
//
// Scope stack is `[userOrgScope, orgScope]` — innermost first. The
// user-within-org scope id (`user-org:${userId}:${orgId}`) intentionally
// includes the org id so the same WorkOS user in a different org gets a
// distinct scope row; future workspace scopes can slot in between without
// conflicting with a hypothetical global user scope.
//
// OAuth token writes require an explicit `tokenScope`. User sign-in UI passes
// the user-org scope so a member's access/refresh tokens cannot leak to other
// members via `secrets.list`, while source rows and org-wide credentials live
// on the outer scope.
// ---------------------------------------------------------------------------

export const createScopedExecutor = (
  userId: string,
  organizationId: string,
  organizationName: string,
) =>
  Effect.gen(function* () {
    const { db } = yield* DbService;

    const plugins = orgPlugins();
    const httpClientLayer = makeHostedHttpClientLayer({
      allowLocalNetwork: env.NODE_ENV === "test",
    });
    const schema = collectSchemas(plugins);
    const adapter = makePostgresAdapter({ db, schema });
    const blobs = makePostgresBlobStore({ db });

    const orgScope = new Scope({
      id: ScopeId.make(organizationId),
      name: organizationName,
      createdAt: new Date(),
    });
    const userOrgScope = new Scope({
      id: ScopeId.make(`user-org:${userId}:${organizationId}`),
      name: `Personal · ${organizationName}`,
      createdAt: new Date(),
    });

    // The executor surface returns raw `StorageFailure`; translation to
    // the opaque `InternalError({ traceId })` happens at the HTTP edge
    // via `withCapture` (see `api/protected-layers.ts`). That's
    // where `ErrorCaptureLive` (Sentry) gets wired in.
    return yield* createExecutor({
      scopes: [userOrgScope, orgScope],
      adapter,
      blobs,
      plugins,
      httpClientLayer,
      onElicitation: "accept-all",
    });
  });
