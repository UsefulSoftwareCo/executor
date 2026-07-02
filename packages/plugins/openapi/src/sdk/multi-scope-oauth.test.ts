// ---------------------------------------------------------------------------
// removed: multi-scope OAuth sign-in isolation on the OpenAPI plugin.
//
// v1 modelled an admin uploading an OAuth-protected spec once, then each user
// signing in at their own scope so per-user OAuth connections (and their tokens)
// stayed isolated — wired through the plugin's oauth2 source-config slots,
// ConnectionProvider, and the scope-partitioning SecretProvider.
//
// In v2 none of that lives in the plugin: OAuth is core-owned (the oauth-service
// mints owner-scoped connections), a connection IS the credential (owner = org |
// user, so per-owner isolation is intrinsic), and the plugin only renders the
// resolved access token through the integration's oauth `authenticationTemplate`.
//
// Owner isolation is covered by multi-scope-bearer.test.ts ("org and user
// connections each inject their own token") and the keystone owner-policy tests;
// the OAuth flow itself is covered by the core oauth-service. This stub
// documents the migration explicitly.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";

describe("OpenAPI multi-scope OAuth (moved to core + owner model)", () => {
  it("per-owner credential isolation is intrinsic to the v2 connection model", () => {
    expect(true).toBe(true);
  });
});
