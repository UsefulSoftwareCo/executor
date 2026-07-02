// ---------------------------------------------------------------------------
// removed: plugin-level OAuth client-credentials flow.
//
// v1 tested the `client_credentials` grant through the OpenAPI plugin's own
// oauth2 source-config slots (clientIdSlot / clientSecretSlot / connectionSlot)
// and ConnectionProvider. In v2 OAuth — including the client-credentials grant —
// is core-owned: an `OAuthClient` (with `grant: "client_credentials"`) is
// registered through the executor's `oauth.*` surface, the oauth-service mints
// and refreshes the connection, and the plugin only renders the resolved access
// token through the integration's oauth `authenticationTemplate`.
//
// Client-credentials token exchange now lives in packages/core/sdk
// (oauth-helpers.test.ts / oauth-service). The plugin's only contribution — the
// oauth bearer rendering — is covered by plugin.test.ts. This stub documents the
// migration explicitly.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";

describe("OpenAPI client-credentials OAuth (moved to core)", () => {
  it("is owned by the core oauth-service, not the plugin", () => {
    expect(true).toBe(true);
  });
});
