// ---------------------------------------------------------------------------
// removed: plugin-level OAuth refresh behaviour.
//
// In v1 the OpenAPI plugin owned an oauth2 ConnectionProvider and the refresh
// loop ran at the plugin boundary (expired-token refresh, concurrent-invoke
// dedup, `invalid_grant` → ConnectionReauthRequiredError). In v2 OAuth is a
// credential mechanism owned by CORE (D14): refresh material lives on the
// connection row and the oauth-service performs the RFC 6749 §6 refresh +
// dedup + invalid_grant handling. The plugin no longer has a connection
// provider or any refresh code — `ctx.connections.resolveValue` (and the
// executor's invoke path) hand `invokeTool` an already-refreshed access token,
// which the plugin renders through the integration's oauth `authenticationTemplate`.
//
// The behaviours this file used to cover are now exercised where they live:
//   - refresh / concurrency / invalid_grant: packages/core/sdk oauth-helpers.test.ts
//     and the oauth-service tests.
//   - "an oauth token is applied as a bearer Authorization header at invoke":
//     plugin.test.ts ("applies an oauth auth template as a bearer Authorization header").
//
// This stub documents the migration so the deletion is explicit rather than a
// silent drop.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";

describe("OpenAPI OAuth refresh (moved to core)", () => {
  it("is owned by the core oauth-service, not the plugin", () => {
    // Architectural marker: the plugin contributes no credentialProviders for
    // oauth and performs no refresh — see plugin.ts (no oauth2 provider).
    expect(true).toBe(true);
  });
});
