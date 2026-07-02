import { describe, expect, it } from "@effect/vitest";

import {
  migrationOAuthAuthorizationUrlFor,
  migrationOAuthClientAuthorizationUrlResolutionSource,
  migrationOAuthClientNeedsAuthorizationUrlResolution,
  migrationOAuthClientPlanKey,
  resolveMigrationOAuthAuthorizationUrls,
  type MigrationOAuthMetadataFetch,
  type MigrationPlan,
} from "./migration-spec";

type OAuthClient = MigrationPlan["oauthClients"][number];

const ownerKeys = { owner: "user" as const, subject: "user_1", tenant: "org_1" };

const oauthClient = (overrides: Partial<OAuthClient> = {}): OAuthClient => ({
  ownerKeys,
  clientId: "client-id",
  tokenUrl: "https://oauth.example.com/token",
  authorizationUrl: "https://oauth.example.com/authorize",
  grant: "authorization_code",
  resource: null,
  clientSecretRef: null,
  slug: "oauth",
  clientSecretItemId: null,
  ...overrides,
});

const migrationPlan = (oauthClients: readonly OAuthClient[]): MigrationPlan => ({
  integrations: [],
  oauthClients,
  connections: [],
  secretOps: [],
  policies: [],
  report: {
    integrations: 0,
    oauthClients: oauthClients.length,
    connections: 0,
    secretOps: 0,
    staleConnections: 0,
    policies: { ok: 0, static: 0, deadInert: 0 },
    warnings: [],
  },
});

const jsonResponse = (
  body: unknown,
  status = 200,
): Awaited<ReturnType<MigrationOAuthMetadataFetch>> => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const fetchFixture = (
  responses: Readonly<Record<string, { readonly body: unknown; readonly status?: number }>>,
): {
  readonly fetch: MigrationOAuthMetadataFetch;
  readonly seen: readonly string[];
} => {
  const seen: string[] = [];
  return {
    seen,
    fetch: async (input) => {
      seen.push(input);
      const response = responses[input];
      if (!response) return jsonResponse({ error: "not_found" }, 404);
      return jsonResponse(response.body, response.status ?? 200);
    },
  };
};

describe("resolveMigrationOAuthAuthorizationUrls", () => {
  it("uses an archived authorization-server metadata URL when present", async () => {
    const metadataUrl =
      "https://mcp.pscale.dev/.well-known/oauth-authorization-server/mcp/planetscale";
    const client = oauthClient({
      slug: "planetscale",
      authorizationUrl: "https://mcp.pscale.dev/mcp/planetscale",
      authorizationServerMetadataUrl: metadataUrl,
      resource: "https://mcp.pscale.dev/mcp/planetscale",
    });
    const fixture = fetchFixture({
      [metadataUrl]: {
        body: {
          authorization_endpoint: "https://app.planetscale.com/oauth/authorize",
        },
      },
    });

    const resolved = await resolveMigrationOAuthAuthorizationUrls(migrationPlan([client]), {
      fetch: fixture.fetch,
    });

    expect(fixture.seen).toEqual([metadataUrl]);
    expect(resolved.get(migrationOAuthClientPlanKey(client))).toBe(
      "https://app.planetscale.com/oauth/authorize",
    );
    expect(migrationOAuthAuthorizationUrlFor(client, resolved)).toBe(
      "https://app.planetscale.com/oauth/authorize",
    );
  });

  it("discovers an MCP authorization endpoint through protected-resource metadata", async () => {
    const client = oauthClient({
      slug: "linear",
      authorizationUrl: "https://mcp.linear.example.com",
      tokenUrl: "https://mcp.linear.example.com/token",
      resource: "https://mcp.linear.example.com/mcp",
    });
    const fixture = fetchFixture({
      "https://mcp.linear.example.com/.well-known/oauth-protected-resource/mcp": {
        body: { authorization_servers: ["https://mcp.linear.example.com"] },
      },
      "https://mcp.linear.example.com/.well-known/oauth-authorization-server": {
        body: {
          authorization_endpoint: "https://mcp.linear.example.com/authorize",
        },
      },
    });

    const resolved = await resolveMigrationOAuthAuthorizationUrls(migrationPlan([client]), {
      fetch: fixture.fetch,
    });

    expect(fixture.seen).toEqual([
      "https://mcp.linear.example.com/.well-known/oauth-protected-resource/mcp",
      "https://mcp.linear.example.com/.well-known/oauth-authorization-server",
    ]);
    expect(resolved.get(migrationOAuthClientPlanKey(client))).toBe(
      "https://mcp.linear.example.com/authorize",
    );
  });

  it("discovers an authorization endpoint from an issuer-root authorization URL", async () => {
    const client = oauthClient({
      slug: "spotify",
      authorizationUrl: "https://accounts.example.com",
      tokenUrl: "https://accounts.example.com/api/token",
    });
    const fixture = fetchFixture({
      "https://accounts.example.com/.well-known/oauth-authorization-server": {
        body: {
          authorization_endpoint: "https://accounts.example.com/authorize",
        },
      },
    });

    const resolved = await resolveMigrationOAuthAuthorizationUrls(migrationPlan([client]), {
      fetch: fixture.fetch,
    });

    expect(resolved.get(migrationOAuthClientPlanKey(client))).toBe(
      "https://accounts.example.com/authorize",
    );
  });

  it("leaves an existing authorization endpoint unchanged when discovery cannot prove a replacement", async () => {
    const client = oauthClient({
      slug: "apollo",
      authorizationUrl: "https://mcp.apollo.example.com/mcp/oauth_metadata/redirect_to_authorize",
      tokenUrl: "https://mcp.apollo.example.com/api/v1/oauth/token",
    });
    const fixture = fetchFixture({});

    const resolved = await resolveMigrationOAuthAuthorizationUrls(migrationPlan([client]), {
      fetch: fixture.fetch,
    });

    expect(resolved.has(migrationOAuthClientPlanKey(client))).toBe(false);
    expect(migrationOAuthAuthorizationUrlFor(client, resolved)).toBe(
      "https://mcp.apollo.example.com/mcp/oauth_metadata/redirect_to_authorize",
    );
  });

  it("marks metadata, resource, and issuer-backed authorization-code clients as discoverable", () => {
    expect(
      migrationOAuthClientNeedsAuthorizationUrlResolution(
        oauthClient({ authorizationServerMetadataUrl: "https://oauth.example.com/metadata" }),
      ),
    ).toBe(true);
    expect(
      migrationOAuthClientNeedsAuthorizationUrlResolution(
        oauthClient({ resource: "https://mcp.example.com/mcp" }),
      ),
    ).toBe(true);
    expect(migrationOAuthClientNeedsAuthorizationUrlResolution(oauthClient())).toBe(true);
    expect(
      migrationOAuthClientNeedsAuthorizationUrlResolution(
        oauthClient({ grant: "client_credentials", authorizationUrl: "", resource: null }),
      ),
    ).toBe(false);
    expect(
      migrationOAuthClientAuthorizationUrlResolutionSource(
        oauthClient({
          authorizationServerMetadataUrl: "",
          resource: "https://mcp.example.com/mcp",
        }),
      ),
    ).toBe("https://mcp.example.com/mcp");
  });
});
