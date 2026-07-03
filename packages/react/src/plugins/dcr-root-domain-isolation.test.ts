// The DCR root-domain collision at the picker-classification level (issue #1120).
//
// Two DIFFERENT integrations share one registrable root domain (cloudflare.com)
// but differ by host: a "Cloudflare" MCP integration whose OAuth is on
// mcp.cloudflare.com, and the plain "Cloudflare" REST integration on
// api.cloudflare.com. Connecting the MCP integration Dynamic-Client-Registers an
// oauth_client (origin: dynamic_client_registration) against mcp.cloudflare.com.
//
// The regression PR #1139 missed: that auto-registered client leaking into the
// REST integration's Add-connection app picker. The existing unit tests in
// use-effective-oauth-client.test.ts check DCR exclusion and root-domain tiering
// one picker at a time; this file asserts the CROSS-INTEGRATION property those
// don't: the MCP integration's DCR client is offered in NONE of the REST
// integration's picker tiers, yet stays visible in the MCP integration's own
// auto-registered management list. It runs the exact pure classifier the app
// (add-account-modal.tsx via useOAuthClientsForIntegration) uses to build the
// picker, so it guards the shipped behaviour, not a reimplementation.
//
// The server-side half (that DCR actually mints this row over the wire and
// reuses it on reconnect) is covered by e2e/cloud/dcr-root-domain-isolation.test.ts.
import { describe, expect, it } from "@effect/vitest";
import { IntegrationSlug, OAuthClientSlug, type Owner } from "@executor-js/sdk/shared";
import type { OAuthClientOrigin } from "@executor-js/sdk/shared";

import {
  selectClientsForEndpoints,
  selectDcrClientsForIntegration,
  type OAuthClientOption,
} from "./use-effective-oauth-client";

const client = (
  slug: string,
  opts: {
    readonly owner?: Owner;
    readonly authorizationUrl: string;
    readonly tokenUrl: string;
    readonly origin: OAuthClientOrigin;
  },
): OAuthClientOption => ({
  owner: opts.owner ?? "org",
  slug: OAuthClientSlug.make(slug),
  grant: "authorization_code",
  authorizationUrl: opts.authorizationUrl,
  tokenUrl: opts.tokenUrl,
  clientId: "client-id",
  origin: opts.origin,
});

const MCP_INTEGRATION = IntegrationSlug.make("cloudflare_mcp");
const REST_INTEGRATION = IntegrationSlug.make("cloudflare_api");

// The auto-registered client the MCP connect flow mints, exactly as the API
// projects it (origin.kind = dynamic_client_registration, endpoints on the MCP
// host, stamped with the MCP integration as its origin).
const mcpDcrClient = client("dcr-mcp-cloudflare-com", {
  authorizationUrl: "https://mcp.cloudflare.com/authorize",
  tokenUrl: "https://mcp.cloudflare.com/token",
  origin: { kind: "dynamic_client_registration", integration: MCP_INTEGRATION },
});

// What the REST integration (api.cloudflare.com) declares to its picker.
const restEndpoints = {
  tokenUrl: "https://api.cloudflare.com/client/v4/oauth/token",
  authorizationUrl: "https://api.cloudflare.com/client/v4/oauth/authorize",
  integration: REST_INTEGRATION,
  requireEndpointMatch: true,
} as const;

describe("DCR root-domain isolation across two same-provider integrations", () => {
  it("the MCP integration's DCR client is offered in NO tier of the REST integration's picker", () => {
    const rest = selectClientsForEndpoints([mcpDcrClient], restEndpoints);

    const offeredInAnyTier = [...rest.matched, ...rest.nearMatches, ...rest.unmatched].map((c) =>
      String(c.slug),
    );
    expect(
      offeredInAnyTier,
      "the auto-registered client never surfaces as a selectable app for a same-root integration",
    ).not.toContain("dcr-mcp-cloudflare-com");
    // The three tiers ARE the whole picker; nothing selectable remains.
    expect(offeredInAnyTier, "the picker offers nothing to select").toEqual([]);
    expect(
      rest.matched.length,
      "no exact/intent match, so the REST picker shows the register-an-app CTA",
    ).toBe(0);
    expect(rest.endpointMatched, "an endpoint was declared but nothing matched exactly").toBe(
      false,
    );
  });

  it("a same-root MANUAL app (not DCR) still lands in the near-matches tier, proving the exclusion is DCR-specific", () => {
    // Same mcp.cloudflare.com endpoints, but a manual app: the classifier must
    // still surface it (as a subdued near-match), so the empty picker above is
    // due to the DCR origin, not the host mismatch.
    const manualNearMiss = client("cloudflare-mcp-manual", {
      authorizationUrl: "https://mcp.cloudflare.com/authorize",
      tokenUrl: "https://mcp.cloudflare.com/token",
      origin: { kind: "manual", integration: null },
    });
    const rest = selectClientsForEndpoints([manualNearMiss, mcpDcrClient], restEndpoints);

    expect(
      rest.nearMatches.map((c) => String(c.slug)),
      "the manual same-root app is a tier-2 near-match",
    ).toEqual(["cloudflare-mcp-manual"]);
    expect(
      [...rest.matched, ...rest.nearMatches, ...rest.unmatched].map((c) => String(c.slug)),
      "the DCR client is still excluded even alongside a pickable manual app",
    ).not.toContain("dcr-mcp-cloudflare-com");
  });

  it("the DCR client stays visible in the MCP integration's own auto-registered management list", () => {
    // Hidden from the picker is not hidden from management: the MCP integration
    // that minted it must still be able to review and remove it.
    const managed = selectDcrClientsForIntegration([mcpDcrClient], {
      integration: MCP_INTEGRATION,
      tokenUrl: "https://mcp.cloudflare.com/token",
      authorizationUrl: "https://mcp.cloudflare.com/authorize",
    });
    expect(
      managed.map((c) => String(c.slug)),
      "the auto-registered client is manageable from the integration that created it",
    ).toEqual(["dcr-mcp-cloudflare-com"]);
  });
});
