// ---------------------------------------------------------------------------
// vitest-pool-workers test entry
// ---------------------------------------------------------------------------
//
// Re-exports the real McpSessionDO and drives /mcp + /.well-known/* through
// the same Effect HttpEffect the prod worker uses. Only the `McpAuth` service
// is swapped: the real impl calls WorkOS's JWKS endpoint, which can't be
// reached from the test isolate.
//
// `stdio`-transport branch of plugin-mcp is now dynamically imported (see
// packages/plugins/mcp/src/sdk/connection.ts), so `@modelcontextprotocol/
// sdk/client/stdio.js` no longer touches `node:child_process` at module
// load — that was SIGSEGV-ing workerd during test instantiation.
// ---------------------------------------------------------------------------

import { HttpEffect } from "effect/unstable/http";
import { Effect, Layer } from "effect";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import {
  McpAuth,
  McpAuthLive,
  McpOrganizationAuth,
  McpOrganizationAuthLive,
  classifyMcpPath,
  mcpAuthorized,
  mcpApp,
  mcpUnauthorized,
} from "./mcp";
import { ApiKeyService } from "./auth/api-keys";
import { McpJwtVerificationError } from "./mcp-auth";
import { organizations } from "./services/schema";
import { parseTestBearer } from "./test-bearer";
import { DoTelemetryLive } from "./services/telemetry";
import { CoreSharedServices } from "./api/core-shared-services";

export { McpSessionDO } from "./mcp-session";

const TestMcpAuthLive = Layer.succeed(McpAuth)({
  verifyBearer: (request) =>
    Effect.gen(function* () {
      const header = request.headers.get("authorization");
      if (!header?.startsWith("Bearer ")) return mcpUnauthorized("missing_bearer");
      const rawToken = header.slice("Bearer ".length);
      if (rawToken === "test-system-error") {
        return yield* new McpJwtVerificationError({
          cause: "simulated_jwks_fetch_failure",
          reason: "system",
        });
      }
      const token = parseTestBearer(rawToken);
      return token ? mcpAuthorized(token) : mcpUnauthorized("invalid_token");
    }),
});

const TestMcpOrganizationAuthLive = Layer.succeed(McpOrganizationAuth)({
  authorize: (_accountId, organizationId) => Effect.succeed(!organizationId.startsWith("revoked_")),
});

// ---------------------------------------------------------------------------
// Test seed endpoint
// ---------------------------------------------------------------------------
//
// Exposed at POST /__test__/seed-org. Tests call it via SELF.fetch to insert
// organization rows into the same PGlite-backed database the DO reads from. Doing
// the insert from inside the test worker avoids pulling postgres.js into the
// test file's top-level imports (which segfaulted workerd during test
// module instantiation).
// ---------------------------------------------------------------------------

const seedConnectionString = (envArg: Record<string, unknown>) =>
  (envArg.DATABASE_URL as string | undefined) ??
  "postgresql://postgres:postgres@127.0.0.1:5434/postgres";

// Per-request postgres connection. Sharing a `Sql` across requests breaks
// mid-suite — vitest-pool-workers' isolate resets tear down the socket and
// the next insert errors with "read end of pipe was aborted". Open + close
// per request; the test DO runtime does the same to avoid workerd's
// cross-request I/O guard.
const handleSeedOrg = async (
  request: Request,
  envArg: Record<string, unknown>,
): Promise<Response> => {
  const body = (await request.json()) as { id: string; name: string };
  const sql: Sql = postgres(seedConnectionString(envArg), {
    max: 1,
    idle_timeout: 0,
    max_lifetime: 30,
    connect_timeout: 10,
    onnotice: () => undefined,
  });
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: worker seed endpoint keeps postgres cleanup in native async finalization
  try {
    await drizzle(sql, { schema: { organizations } })
      .insert(organizations)
      .values({ id: body.id, name: body.name })
      .onConflictDoUpdate({
        target: organizations.id,
        set: { name: body.name },
      });
  } finally {
    // oxlint-disable-next-line executor/no-promise-catch -- boundary: best-effort postgres close during worker seed endpoint cleanup
    await sql.end({ timeout: 0 }).catch(() => undefined);
  }
  return new Response(null, { status: 204 });
};

// Provide a WebSdk-backed tracer on the worker side so the `mcp.request` span
// gets reported to the OTLP receiver. This is the same Worker-safe telemetry
// layer used in prod.
const testMcpFetch = HttpEffect.toWebHandler(
  mcpApp.pipe(
    Effect.provide(Layer.mergeAll(TestMcpAuthLive, TestMcpOrganizationAuthLive, DoTelemetryLive)),
  ),
);

const realAuthMcpFetch = HttpEffect.toWebHandler(
  mcpApp.pipe(
    Effect.provide(
      Layer.mergeAll(
        McpAuthLive.pipe(
          Layer.provide(ApiKeyService.WorkOS.pipe(Layer.provide(CoreSharedServices))),
        ),
        McpOrganizationAuthLive,
        DoTelemetryLive,
      ),
    ),
  ),
);

export default {
  async fetch(request: Request, envArg: Record<string, unknown>): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__test__/seed-org" && request.method === "POST") {
      return handleSeedOrg(request, envArg);
    }
    if (url.pathname === "/__test__/real-auth-mcp") {
      const mcpUrl = new URL(request.url);
      mcpUrl.pathname = "/mcp";
      return realAuthMcpFetch(new Request(mcpUrl, request));
    }
    if (classifyMcpPath(url.pathname) !== null) {
      return testMcpFetch(request);
    }
    return new Response("not found", { status: 404 });
  },
};
