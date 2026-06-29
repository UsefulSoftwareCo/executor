import { describe, it, expect } from "@effect/vitest";

import {
  parseScope,
  ownerPartitionKey,
  vaultV1ObjectName,
  vaultV1LegacyObjectName,
  vaultV2ObjectName,
  oauthClientDedupKey,
  serializeOAuthScopes,
  migratePolicyPattern,
  migrateOpenApiAuthTemplate,
  API_KEY_TEMPLATE_SLUG,
  migrateGrant,
  migrateExpiresAt,
  SYNTHETIC_CLIENT_CREDENTIALS_TTL_MS,
  migrateOpenApiSourceConfig,
  migrateSourceAuth,
  classifyBindingSlot,
  dedupeOAuthClients,
  oauthClientSlugKey,
  planIntegrationRow,
  planConnectionRow,
  migratedItemId,
  migrateMcpSourceConfig,
  migrateGraphqlSourceConfig,
  OAUTH_TEMPLATE_SLUG,
  planMigration,
  buildV1RuntimeMetadataIndex,
  migrateV1PluginStorageRuntimeRow,
  migrateV1ToolAnnotations,
} from "./migration-spec";
import type { MigrationInput, MigratedSourceConfig } from "./migration-spec";

describe("parseScope", () => {
  it("maps a bare org scope to owner=org, empty subject", () => {
    expect(parseScope("org_01KRFBFKMP")).toEqual({
      owner: "org",
      subject: "",
      tenant: "org_01KRFBFKMP",
    });
  });

  it("maps a user-org scope to owner=user with subject + tenant", () => {
    expect(parseScope("user-org:user_01ABC:org_01XYZ")).toEqual({
      owner: "user",
      subject: "user_01ABC",
      tenant: "org_01XYZ",
    });
  });

  it("fails loud (null) on unknown shapes rather than mis-owning", () => {
    expect(parseScope("user_01ABC")).toBeNull(); // bare user, no org — not a v2 shape
    expect(parseScope("local-folder-hash")).toBeNull();
    expect(parseScope("user-org:org_01XYZ")).toBeNull(); // missing user segment
    expect(parseScope("user-org:user_01:org_02:extra")).toBeNull(); // too many segments
    expect(parseScope("org_01:trailing")).toBeNull(); // org with a colon
    expect(parseScope("")).toBeNull();
  });
});

describe("ownerPartitionKey", () => {
  it("collapses org apps across the org, keeps user apps per-user", () => {
    expect(ownerPartitionKey({ owner: "org", subject: "", tenant: "org_X" })).toBe("org:org_X");
    expect(ownerPartitionKey({ owner: "user", subject: "user_U", tenant: "org_X" })).toBe(
      "user:user_U:org_X",
    );
  });
});

describe("vault object naming", () => {
  it("v1 name carries the scope segment + url-encodes both parts", () => {
    expect(vaultV1ObjectName("executor", "user-org:user_U:org_O", "sec_a/b")).toBe(
      "executor/user-org%3Auser_U%3Aorg_O/secrets/sec_a%2Fb",
    );
  });

  it("v1 legacy name leaves the segments un-encoded (the 404 fallback)", () => {
    expect(vaultV1LegacyObjectName("executor", "org_X", "sec_a")).toBe(
      "executor/org_X/secrets/sec_a",
    );
  });

  it("v2 name drops the scope segment (flat namespace)", () => {
    expect(vaultV2ObjectName("executor", "item_a/b")).toBe("executor/secrets/item_a%2Fb");
  });

  it("v1 and v2 names differ → id-reuse is impossible (the whole reason to re-key)", () => {
    const scope = "org_X";
    const id = "sec_1";
    expect(vaultV1ObjectName("executor", scope, id)).not.toBe(vaultV2ObjectName("executor", id));
  });
});

describe("oauthClientDedupKey", () => {
  it("merges identical (partition, clientId, tokenEndpoint), distinguishes any difference", () => {
    const a = oauthClientDedupKey("org:org_X", "cid", "https://t/token");
    const b = oauthClientDedupKey("org:org_X", "cid", "https://t/token");
    const c = oauthClientDedupKey("user:u:org_X", "cid", "https://t/token");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("serializeOAuthScopes", () => {
  it("space-joins, de-dupes order-preserving, drops empties", () => {
    expect(serializeOAuthScopes(["data", "api", "data", ""])).toBe("data api");
    expect(serializeOAuthScopes(["vanta-api.all:read", "vanta-api.vendors:read"])).toBe(
      "vanta-api.all:read vanta-api.vendors:read",
    );
    expect(serializeOAuthScopes([])).toBe("");
  });
});

describe("migratePolicyPattern", () => {
  const M = new Map([
    ["github_v3_rest_api", "github"], // a rename
    ["microsoft_graph", "microsoft_graph"], // no-op slug
    ["dealcloud_api", "dealcloud_api"],
  ]);

  it("universal pattern passes through", () => {
    expect(migratePolicyPattern("*", M)).toEqual({ kind: "ok", pattern: "*" });
  });

  it("static namespaces pass through verbatim", () => {
    expect(migratePolicyPattern("executor.openapi.addSource", M)).toEqual({
      kind: "static",
      pattern: "executor.openapi.addSource",
    });
    expect(migratePolicyPattern("openapi.addSource", M)).toEqual({
      kind: "static",
      pattern: "openapi.addSource",
    });
  });

  it("whole-integration (`slug.*`) only remaps the slug — trailing * already a subtree", () => {
    expect(migratePolicyPattern("dealcloud_api.*", M)).toEqual({
      kind: "ok",
      pattern: "dealcloud_api.*",
    });
    expect(migratePolicyPattern("github_v3_rest_api.*", M)).toEqual({
      kind: "ok",
      pattern: "github.*",
    });
  });

  it("exact / subtree patterns insert the owner+connection wildcards", () => {
    expect(migratePolicyPattern("microsoft_graph.meEvent.meEventsEventCancel", M)).toEqual({
      kind: "ok",
      pattern: "microsoft_graph.*.*.meEvent.meEventsEventCancel",
    });
    expect(migratePolicyPattern("github_v3_rest_api.repos.deleteAccessRestrictions", M)).toEqual({
      kind: "ok",
      pattern: "github.*.*.repos.deleteAccessRestrictions",
    });
    expect(migratePolicyPattern("microsoft_graph.meCalendar.*", M)).toEqual({
      kind: "ok",
      pattern: "microsoft_graph.*.*.meCalendar.*",
    });
  });

  it("an unknown first segment is flagged DEAD (source removed) — never silently dropped", () => {
    expect(migratePolicyPattern("api_githubcopilot_com.delete_file", M)).toEqual({
      kind: "dead",
      slug: "api_githubcopilot_com",
    });
  });
});

describe("plugin runtime metadata migration", () => {
  it("stamps MCP tool annotations from the legacy binding without changing the Executor slug", () => {
    const index = buildV1RuntimeMetadataIndex([
      {
        scopeId: "org_X",
        pluginId: "mcp",
        collection: "binding",
        key: "axiom_mcp.querydataset",
        data: {
          namespace: "axiom_mcp",
          toolId: "axiom_mcp.querydataset",
          binding: {
            toolId: "querydataset",
            toolName: "queryDataset",
            annotations: { title: "Query dataset", readOnlyHint: true },
          },
        },
      },
    ]);

    const annotations = migrateV1ToolAnnotations(
      {
        scopeId: "org_X",
        sourceId: "axiom_mcp",
        pluginId: "mcp",
        name: "querydataset",
        annotations: null,
      },
      index,
    );

    expect(annotations).toEqual({
      requiresApproval: false,
      mcp: {
        toolName: "queryDataset",
        upstream: { title: "Query dataset", readOnlyHint: true },
      },
    });
  });

  it("keeps already-stamped MCP annotations unchanged for idempotent re-runs", () => {
    const annotations = {
      requiresApproval: true,
      mcp: { toolName: "deleteDataset", upstream: { destructiveHint: true } },
    };

    expect(
      migrateV1ToolAnnotations(
        {
          scopeId: "org_X",
          sourceId: "axiom_mcp",
          pluginId: "mcp",
          name: "deletedataset",
          annotations,
        },
        buildV1RuntimeMetadataIndex([]),
      ),
    ).toBe(annotations);
  });

  it("rewrites v1 OpenAPI operation storage to the v2 catalog-owned shape", () => {
    expect(
      migrateV1PluginStorageRuntimeRow({
        scopeId: "user-org:user_U:org_X",
        pluginId: "openapi",
        collection: "operation",
        key: "vercel_api.dns.getRecords",
        data: {
          toolId: "vercel_api.dns.getRecords",
          sourceId: "vercel_api",
          binding: { method: "get", pathTemplate: "/v4/domains/{domain}/records" },
        },
      }),
    ).toEqual({
      pluginId: "openapi",
      collection: "operation",
      key: "vercel_api.dns.getRecords",
      data: {
        integration: "vercel_api",
        toolName: "dns.getRecords",
        binding: { method: "get", pathTemplate: "/v4/domains/{domain}/records" },
      },
      owner: "catalog",
    });
  });

  it("rewrites v1 GraphQL operation storage and normalizes graphql-greenfield ids", () => {
    expect(
      migrateV1PluginStorageRuntimeRow({
        scopeId: "org_X",
        pluginId: "graphql-greenfield",
        collection: "operation",
        key: "graphql_api.query.hello",
        data: {
          toolId: "graphql_api.query.hello",
          sourceId: "graphql_api",
          binding: { kind: "query", fieldName: "hello", operationString: "query { hello }" },
        },
      }),
    ).toEqual({
      pluginId: "graphql",
      collection: "operation",
      key: "graphql_api.query.hello",
      data: {
        integration: "graphql_api",
        toolName: "query.hello",
        binding: { kind: "query", fieldName: "hello", operationString: "query { hello }" },
      },
      owner: "catalog",
    });
  });

  it("keeps source-owned plugin storage rows source-owned", () => {
    expect(
      migrateV1PluginStorageRuntimeRow({
        scopeId: "org_X",
        pluginId: "onepassword",
        collection: "settings",
        key: "config",
        data: { vaultId: "vault_123" },
      }),
    ).toEqual({
      pluginId: "onepassword",
      collection: "settings",
      key: "config",
      data: { vaultId: "vault_123" },
      owner: "source",
    });
  });
});

describe("migrateOpenApiAuthTemplate", () => {
  it("maps a single Bearer apiKey header to one apiKey method (prefix preserved)", () => {
    const r = migrateOpenApiAuthTemplate({
      headers: {
        Authorization: { kind: "binding", slot: "header:authorization", prefix: "Bearer " },
      },
    });
    expect(r.authenticationTemplate).toEqual([
      {
        slug: API_KEY_TEMPLATE_SLUG,
        type: "apiKey",
        headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
      },
    ]);
    expect(r.slotToTemplateSlug).toEqual({ "header:authorization": API_KEY_TEMPLATE_SLUG });
    expect(r.slotToVariable).toEqual({ "header:authorization": "token" });
    expect(r.staticHeaders).toEqual({});
  });

  it("a prefix-less apiKey header renders a bare [token]", () => {
    const r = migrateOpenApiAuthTemplate({
      headers: { "X-Api-Key": { kind: "binding", slot: "header:x-api-key" } },
    });
    expect(r.authenticationTemplate[0]).toEqual({
      slug: API_KEY_TEMPLATE_SLUG,
      type: "apiKey",
      headers: { "X-Api-Key": [{ type: "variable", name: "token" }] },
    });
  });

  it("a query-param api key lands in queryParams, not headers", () => {
    const r = migrateOpenApiAuthTemplate({
      queryParams: { key: { kind: "binding", slot: "query_param:key" } },
    });
    expect(r.authenticationTemplate[0]).toEqual({
      slug: API_KEY_TEMPLATE_SLUG,
      type: "apiKey",
      queryParams: { key: [{ type: "variable", name: "token" }] },
    });
    expect(r.slotToTemplateSlug).toEqual({ "query_param:key": API_KEY_TEMPLATE_SLUG });
  });

  it("literal-string headers pass through as static, never as credentials", () => {
    const r = migrateOpenApiAuthTemplate({
      headers: {
        "User-Agent": "executor/1.0",
        Authorization: { kind: "binding", slot: "header:authorization", prefix: "Bearer " },
      },
    });
    expect(r.staticHeaders).toEqual({ "User-Agent": "executor/1.0" });
    expect(r.authenticationTemplate).toHaveLength(1);
    // The lone credential placement stays the canonical `token`.
    expect(r.slotToVariable).toEqual({ "header:authorization": "token" });
  });

  it("converts oauth2 to an oauth method keyed on its security-scheme slug", () => {
    const r = migrateOpenApiAuthTemplate({
      oauth2: {
        securitySchemeName: "googleOAuth2",
        flow: "authorizationCode",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: ["https://www.googleapis.com/auth/calendar"],
      },
    });
    expect(r.authenticationTemplate).toEqual([
      {
        slug: "googleOAuth2",
        type: "oauth",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: ["https://www.googleapis.com/auth/calendar"],
      },
    ]);
    expect(r.slotToTemplateSlug).toEqual({ "oauth2:googleoauth2:connection": "googleOAuth2" });
  });

  it("maps hyphenated legacy oauth slot names to underscored oauth slugs", () => {
    const r = migrateOpenApiAuthTemplate({
      oauth2: {
        securitySchemeName: "oauth_2_0",
        flow: "authorizationCode",
        authorizationUrl: "https://accounts.spotify.com/authorize",
        tokenUrl: "https://accounts.spotify.com/api/token",
        scopes: ["user-read-email"],
      },
    });

    expect(r.slotToTemplateSlug["oauth2:oauth-2-0:connection"]).toBe("oauth_2_0");
    expect(r.slotToVariable["oauth2:oauth-2-0:connection"]).toBe("token");
  });

  it("a source offering both apiKey and oauth declares both methods", () => {
    const r = migrateOpenApiAuthTemplate({
      headers: {
        Authorization: { kind: "binding", slot: "header:authorization", prefix: "Bearer " },
      },
      oauth2: {
        securitySchemeName: "oauth2",
        tokenUrl: "https://example.com/token",
        scopes: [],
      },
    });
    expect(r.authenticationTemplate.map((m) => m.type)).toEqual(["apiKey", "oauth"]);
  });

  it("gives two distinct credential placements (Datadog) their own variables", () => {
    const r = migrateOpenApiAuthTemplate({
      headers: {
        "DD-API-KEY": { kind: "binding", slot: "header:dd-api-key" },
        "DD-APPLICATION-KEY": { kind: "binding", slot: "header:dd-application-key" },
      },
    });
    expect(r.authenticationTemplate).toEqual([
      {
        slug: API_KEY_TEMPLATE_SLUG,
        type: "apiKey",
        headers: {
          "DD-API-KEY": [{ type: "variable", name: "dd_api_key" }],
          "DD-APPLICATION-KEY": [{ type: "variable", name: "dd_application_key" }],
        },
      },
    ]);
    expect(r.slotToVariable).toEqual({
      "header:dd-api-key": "dd_api_key",
      "header:dd-application-key": "dd_application_key",
    });
    expect(r.warnings).toEqual([]);
  });

  it("an auth-less source yields an empty template", () => {
    const r = migrateOpenApiAuthTemplate({});
    expect(r.authenticationTemplate).toEqual([]);
    expect(r.slotToTemplateSlug).toEqual({});
    expect(r.slotToVariable).toEqual({});
  });
});

describe("migrateGrant", () => {
  it("maps client-credentials to client_credentials, everything else to authorization_code", () => {
    expect(migrateGrant("client-credentials")).toBe("client_credentials");
    expect(migrateGrant("authorization-code")).toBe("authorization_code");
    expect(migrateGrant("dynamic-dcr")).toBe("authorization_code");
  });
});

describe("migrateExpiresAt (C1a)", () => {
  const now = 1_700_000_000_000;

  it("synthesizes a 1h expiry for a client_credentials connection with null v1 expiry", () => {
    expect(migrateExpiresAt({ grant: "client_credentials", v1ExpiresAt: null, nowMs: now })).toBe(
      now + SYNTHETIC_CLIENT_CREDENTIALS_TTL_MS,
    );
    expect(SYNTHETIC_CLIENT_CREDENTIALS_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("keeps a real v1 expiry for client_credentials (only backfills the null case)", () => {
    expect(migrateExpiresAt({ grant: "client_credentials", v1ExpiresAt: 123, nowMs: now })).toBe(
      123,
    );
  });

  it("never synthesizes for authorization_code (null stays null — re-auth on use)", () => {
    expect(
      migrateExpiresAt({ grant: "authorization_code", v1ExpiresAt: null, nowMs: now }),
    ).toBeNull();
    expect(migrateExpiresAt({ grant: "authorization_code", v1ExpiresAt: 456, nowMs: now })).toBe(
      456,
    );
  });
});

describe("migrateOpenApiSourceConfig", () => {
  it("copies structural fields, drops namespace, and converts auth to a template", () => {
    const r = migrateOpenApiSourceConfig({
      spec: "{openapi}",
      sourceUrl: "https://api.example.com/openapi.json",
      baseUrl: "https://api.example.com",
      headers: {
        "User-Agent": "executor/1.0",
        Authorization: { kind: "binding", slot: "header:authorization", prefix: "Bearer " },
      },
    });
    const config = r.config as {
      readonly spec?: string;
      readonly sourceUrl?: string;
      readonly baseUrl?: string;
      readonly headers?: Record<string, string>;
      readonly authenticationTemplate?: unknown;
    };
    expect(config.spec).toBe("{openapi}");
    expect(config.sourceUrl).toBe("https://api.example.com/openapi.json");
    expect(config.baseUrl).toBe("https://api.example.com");
    // The literal header is static config; the credential header became a template.
    expect(config.headers).toEqual({ "User-Agent": "executor/1.0" });
    expect(config.authenticationTemplate).toEqual([
      {
        slug: API_KEY_TEMPLATE_SLUG,
        type: "apiKey",
        headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
      },
    ]);
    expect(r.slotToVariable).toEqual({ "header:authorization": "token" });
    // namespace is never carried into v2 config.
    expect("namespace" in (r.config as object)).toBe(false);
  });

  it("omits absent fields and emits no empty template for an auth-less source", () => {
    const r = migrateOpenApiSourceConfig({ spec: "{}" });
    expect(r.config).toEqual({ spec: "{}" });
  });
});

describe("migrateSourceAuth (mcp/graphql)", () => {
  it("strips the connection slot from an oauth2 auth block", () => {
    expect(migrateSourceAuth({ kind: "oauth2", connectionSlot: "auth:oauth2:connection" })).toEqual(
      {
        kind: "oauth2",
      },
    );
  });

  it("passes through none, and treats absent auth as none", () => {
    expect(migrateSourceAuth({ kind: "none" })).toEqual({ kind: "none" });
    expect(migrateSourceAuth(undefined)).toEqual({ kind: "none" });
  });
});

describe("classifyBindingSlot", () => {
  it("classifies api-key carriers (header / query / spec-fetch)", () => {
    expect(classifyBindingSlot("header:authorization")).toBe("apikey");
    expect(classifyBindingSlot("query_param:key")).toBe("apikey");
    expect(classifyBindingSlot("spec_fetch_header:authorization")).toBe("apikey");
  });

  it("classifies BYO client credential slots", () => {
    expect(classifyBindingSlot("oauth2:azureaddelegated:client-secret")).toBe("client-secret");
    expect(classifyBindingSlot("oauth2:googleoauth2:client-id")).toBe("client-id");
  });

  it("classifies an oauth connection slot as the access token", () => {
    expect(classifyBindingSlot("oauth2:oauth2:connection")).toBe("oauth-access");
    expect(classifyBindingSlot("auth:oauth2:connection")).toBe("oauth-access");
  });
});

describe("dedupeOAuthClients", () => {
  const orgKeys = { owner: "org" as const, subject: "", tenant: "org_X" };
  const userKeys = { owner: "user" as const, subject: "user_U", tenant: "org_X" };

  it("folds identical apps within a partition, keeps distinct ones apart", () => {
    const r = dedupeOAuthClients([
      {
        ownerKeys: orgKeys,
        clientId: "cid",
        tokenUrl: "https://tenant.dealcloud.example/oauth/token",
        authorizationUrl: "",
        grant: "client_credentials",
        resource: null,
        clientSecretRef: "sec_a",
      },
      // identical (same partition + clientId + tokenUrl) → folds away
      {
        ownerKeys: orgKeys,
        clientId: "cid",
        tokenUrl: "https://tenant.dealcloud.example/oauth/token",
        authorizationUrl: "",
        grant: "client_credentials",
        resource: null,
        clientSecretRef: "sec_a",
      },
      // same clientId but a different USER partition → stays separate
      {
        ownerKeys: userKeys,
        clientId: "cid",
        tokenUrl: "https://tenant.dealcloud.example/oauth/token",
        authorizationUrl: "",
        grant: "client_credentials",
        resource: null,
        clientSecretRef: "sec_b",
      },
    ]);
    expect(r.clients).toHaveLength(2);
    expect(r.clients[0]?.slug).toBe("dealcloud");
    // distinct partition reuses the same host-derived slug (slugs are unique
    // only WITHIN a partition).
    expect(r.clients[1]?.slug).toBe("dealcloud");
  });

  it("keeps secret-backed client ids distinct until runners resolve their values", () => {
    const r = dedupeOAuthClients([
      {
        ownerKeys: orgKeys,
        clientId: "",
        clientIdSecretRef: { scopeId: "org_X", secretId: "client-id-a", provider: "workos" },
        tokenUrl: "https://tenant.dealcloud.example/oauth/token",
        authorizationUrl: "",
        grant: "client_credentials",
        resource: null,
        clientSecretRef: "sec_a",
      },
      {
        ownerKeys: orgKeys,
        clientId: "",
        clientIdSecretRef: { scopeId: "org_X", secretId: "client-id-b", provider: "workos" },
        tokenUrl: "https://tenant.dealcloud.example/oauth/token",
        authorizationUrl: "",
        grant: "client_credentials",
        resource: null,
        clientSecretRef: "sec_b",
      },
    ]);
    expect(r.clients.map((c) => c.slug)).toEqual(["dealcloud", "dealcloud_2"]);
  });

  it("disambiguates two distinct apps in the same partition by suffix", () => {
    const r = dedupeOAuthClients([
      {
        ownerKeys: orgKeys,
        clientId: "a",
        tokenUrl: "https://api.acme.com/token",
        authorizationUrl: "",
        grant: "authorization_code",
        resource: null,
        clientSecretRef: null,
      },
      {
        ownerKeys: orgKeys,
        clientId: "b",
        tokenUrl: "https://api.acme.com/token",
        authorizationUrl: "",
        grant: "authorization_code",
        resource: null,
        clientSecretRef: null,
      },
    ]);
    expect(r.clients.map((c) => c.slug)).toEqual(["acme", "acme_2"]);
  });

  it("the slug lookup key round-trips an app to its assigned slug", () => {
    const r = dedupeOAuthClients([
      {
        ownerKeys: orgKeys,
        clientId: "cid",
        tokenUrl: "https://api.vanta.com/oauth/token",
        authorizationUrl: "",
        grant: "client_credentials",
        resource: null,
        clientSecretRef: null,
      },
    ]);
    const key = oauthClientSlugKey({
      ownerKeys: orgKeys,
      clientId: "cid",
      tokenUrl: "https://api.vanta.com/oauth/token",
    });
    expect(r.slugByDedupKey[key]).toBe("vanta");
  });
});

describe("planIntegrationRow", () => {
  it("derives owner/subject/tenant from the source scope, slug = source id", () => {
    expect(
      planIntegrationRow({
        scopeId: "org_X",
        sourceId: "dealcloud_api",
        pluginId: "openapi",
        description: "DealCloud",
        config: { spec: "{}" },
      }),
    ).toEqual({
      tenant: "org_X",
      owner: "org",
      subject: "",
      slug: "dealcloud_api",
      plugin_id: "openapi",
      description: "DealCloud",
      config: { spec: "{}" },
    });
  });

  it("fails loud (null) on an unparseable scope rather than mis-owning", () => {
    expect(
      planIntegrationRow({
        scopeId: "weird-scope",
        sourceId: "x",
        pluginId: "openapi",
        description: "",
        config: {},
      }),
    ).toBeNull();
  });
});

describe("planConnectionRow", () => {
  const now = 1_700_000_000_000;

  it("splits a user-org scope, joins scopes, and carries the oauth client owner", () => {
    const row = planConnectionRow({
      scopeId: "user-org:user_U:org_O",
      integration: "github",
      name: "personal",
      template: "googleOAuth2",
      provider: "workos-vault",
      identityLabel: "me@example.com",
      grant: "authorization_code",
      v1ExpiresAt: 999,
      oauthScopes: ["read", "write", "read"],
      oauthClientSlug: "github",
      oauthClientOwner: { owner: "org", subject: "", tenant: "org_O" },
      nowMs: now,
    });
    expect(row).toEqual({
      tenant: "org_O",
      owner: "user",
      subject: "user_U",
      integration: "github",
      name: "personal",
      template: "googleOAuth2",
      provider: "workos-vault",
      identityLabel: "me@example.com",
      oauthClientSlug: "github",
      oauthClientOwner: "org",
      oauthScope: "read write",
      expiresAt: 999,
    });
  });

  it("applies the C1a synthetic expiry for a null-expiry client_credentials connection", () => {
    const row = planConnectionRow({
      scopeId: "org_X",
      integration: "dealcloud_api",
      name: "service",
      template: "oauth2",
      provider: "workos-vault",
      identityLabel: null,
      grant: "client_credentials",
      v1ExpiresAt: null,
      oauthScopes: [],
      oauthClientSlug: "dealcloud",
      oauthClientOwner: { owner: "org", subject: "", tenant: "org_X" },
      nowMs: now,
    });
    expect(row?.expiresAt).toBe(now + SYNTHETIC_CLIENT_CREDENTIALS_TTL_MS);
    expect(row?.oauthScope).toBeNull();
  });
});

describe("migratedItemId", () => {
  it("is deterministic, opaque, and differs from any v1 name", () => {
    expect(migratedItemId("user-org:user_U:org_O", "sec_a/b")).toMatch(
      /^secret_[A-Za-z0-9_-]{43}$/,
    );
    expect(migratedItemId("user-org:user_U:org_O", "sec_a/b")).not.toContain("user-org");
    expect(migratedItemId("user-org:user_U:org_O", "sec_a/b")).not.toContain("sec_a");
    // same inputs → same id (a re-run reuses the vault item, no duplicate write).
    expect(migratedItemId("org_X", "sec_1")).toBe(migratedItemId("org_X", "sec_1"));
    expect(migratedItemId("org_X", "sec_1")).not.toBe(migratedItemId("org_Y", "sec_1"));
  });
});

describe("migrateMcpSourceConfig / migrateGraphqlSourceConfig", () => {
  it("mcp: copies endpoint/transport, an apikey header → template, oauth2 auth → slot map", () => {
    const r = migrateMcpSourceConfig({
      endpoint: "https://api.example.com/mcp",
      transport: "remote",
      remoteTransport: "auto",
      headers: {
        Authorization: { kind: "binding", slot: "header:authorization", prefix: "Bearer " },
      },
      auth: { kind: "none" },
    });
    const config = r.config as {
      readonly endpoint?: string;
      readonly transport?: string;
      readonly auth?: { readonly kind: string };
      readonly authenticationTemplate?: unknown;
    };
    expect(config.endpoint).toBe("https://api.example.com/mcp");
    expect(config.transport).toBe("remote");
    expect(config.auth).toEqual({ kind: "none" });
    expect(config.authenticationTemplate).toEqual([
      {
        slug: API_KEY_TEMPLATE_SLUG,
        type: "apiKey",
        headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
      },
    ]);
    expect(r.slotToVariable).toEqual({ "header:authorization": "token" });
  });

  it("mcp: an oauth2 auth block maps its connection slot to the conventional oauth template", () => {
    const r = migrateMcpSourceConfig({
      endpoint: "https://mcp.example.com",
      auth: { kind: "oauth2", connectionSlot: "auth:oauth2:connection" },
    });
    expect((r.config as { auth: unknown }).auth).toEqual({ kind: "oauth2" });
    expect(r.slotToTemplateSlug).toEqual({ "auth:oauth2:connection": OAUTH_TEMPLATE_SLUG });
    expect(r.slotToVariable).toEqual({ "auth:oauth2:connection": "token" });
  });

  it("graphql: copies endpoint + converts a bearer header", () => {
    const r = migrateGraphqlSourceConfig({
      endpoint: "https://api.github.com/graphql",
      name: "Github GraphQL",
      headers: {
        Authorization: { kind: "binding", slot: "header:authorization", prefix: "Bearer " },
      },
      auth: { kind: "none" },
    });
    const config = r.config as {
      readonly endpoint?: string;
      readonly authenticationTemplate?: unknown;
    };
    expect(config.endpoint).toBe("https://api.github.com/graphql");
    expect(config.authenticationTemplate).toBeDefined();
  });
});

describe("planMigration (the weave)", () => {
  const cfg = (over: Partial<MigratedSourceConfig> = {}): MigratedSourceConfig => ({
    config: {},
    slotToTemplateSlug: {},
    slotToVariable: {},
    warnings: [],
    ...over,
  });
  const now = 1_700_000_000_000;

  it("weaves a full snapshot into integrations, connections, oauth clients, secret ops, policies", () => {
    const input: MigrationInput = {
      nowMs: now,
      sources: [
        { scopeId: "org_X", id: "stripe_api", pluginId: "openapi", name: "Stripe" },
        { scopeId: "user-org:user_U:org_X", id: "linear_mcp", pluginId: "mcp", name: "Linear MCP" },
      ],
      migratedConfigs: new Map([
        [
          "org_X stripe_api",
          cfg({
            slotToTemplateSlug: { "header:authorization": "apiKey" },
            slotToVariable: { "header:authorization": "token" },
          }),
        ],
        [
          "user-org:user_U:org_X linear_mcp",
          cfg({
            slotToTemplateSlug: { "auth:oauth2:connection": "oauth2" },
            slotToVariable: { "auth:oauth2:connection": "token" },
          }),
        ],
      ]),
      connections: [
        {
          id: "mcp-oauth2-linear_mcp",
          scopeId: "user-org:user_U:org_X",
          provider: "workos-vault",
          identityLabel: "Linear MCP OAuth",
          accessTokenSecretId: "linear-access",
          refreshTokenSecretId: "linear-refresh",
          expiresAt: 555,
          providerState: {
            kind: "dynamic-dcr",
            clientId: "cid-linear",
            clientSecretSecretId: "linear-client-secret",
            tokenEndpoint: "https://mcp.linear.app/token",
            authorizationServerUrl: "https://mcp.linear.app/authorize",
            authorizationServerMetadataUrl:
              "https://mcp.linear.app/.well-known/oauth-authorization-server",
            resource: "https://mcp.linear.app",
            scopes: ["read", "write"],
          },
        },
      ],
      bindings: [
        {
          scopeId: "org_X",
          sourceId: "stripe_api",
          slotKey: "header:authorization",
          kind: "secret",
          secretId: "stripe-key",
          connectionId: null,
          textValue: null,
        },
        {
          scopeId: "user-org:user_U:org_X",
          sourceId: "linear_mcp",
          slotKey: "auth:oauth2:connection",
          kind: "connection",
          secretId: null,
          connectionId: "mcp-oauth2-linear_mcp",
          textValue: null,
        },
      ],
      secrets: [
        {
          id: "stripe-key",
          scopeId: "org_X",
          name: "Stripe key",
          provider: "workos-vault",
          ownedByConnectionId: null,
        },
        {
          id: "linear-access",
          scopeId: "user-org:user_U:org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: "mcp-oauth2-linear_mcp",
        },
        {
          id: "linear-refresh",
          scopeId: "user-org:user_U:org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: "mcp-oauth2-linear_mcp",
        },
        {
          id: "linear-client-secret",
          scopeId: "user-org:user_U:org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: null,
        },
        {
          id: "loose-pat",
          scopeId: "org_X",
          name: "an orphan",
          provider: "workos-vault",
          ownedByConnectionId: null,
        },
      ],
      policies: [
        { scopeId: "org_X", pattern: "stripe_api.charges.create", action: "approve" },
        { scopeId: "org_X", pattern: "deadsource.delete", action: "block" },
      ],
      toolSourceIds: [],
    };

    const plan = planMigration(input);

    // Integrations: one per source, owner derived from scope.
    expect(plan.integrations.map((i) => [i.slug, i.owner, i.subject])).toEqual([
      ["stripe_api", "org", ""],
      ["linear_mcp", "user", "user_U"],
    ]);

    // Connections: an apiKey (stripe) + an oauth (linear).
    const stripe = plan.connections.find((c) => c.row.integration === "stripe_api");
    const linear = plan.connections.find((c) => c.row.integration === "linear_mcp");
    expect(stripe?.row.name).toBe("stripeKey");
    expect(stripe?.row.template).toBe("apiKey");
    expect(stripe?.itemIds.token).toBe(migratedItemId("org_X", "stripe-key"));
    expect(stripe?.row.oauthClientSlug).toBeNull();

    expect(linear?.row.name).toBe("linearMcpOauth");
    expect(linear?.row.template).toBe("oauth2");
    expect(linear?.row.owner).toBe("user");
    expect(linear?.itemIds.token).toBe(migratedItemId("user-org:user_U:org_X", "linear-access"));
    expect(linear?.refreshItemId).toBe(migratedItemId("user-org:user_U:org_X", "linear-refresh"));
    expect(linear?.row.oauthScope).toBe("read write");
    expect(linear?.row.expiresAt).toBe(555);
    // Wired to its deduped client.
    expect(linear?.row.oauthClientSlug).toBe("linear");

    // OAuth client: one, with its secret re-keyed.
    expect(plan.oauthClients).toHaveLength(1);
    expect(plan.oauthClients[0]?.clientId).toBe("cid-linear");
    expect(plan.oauthClients[0]?.authorizationUrl).toBe("https://mcp.linear.app/authorize");
    expect(plan.oauthClients[0]?.authorizationServerMetadataUrl).toBe(
      "https://mcp.linear.app/.well-known/oauth-authorization-server",
    );
    expect(plan.oauthClients[0]?.resource).toBe("https://mcp.linear.app");
    expect(plan.oauthClients[0]?.clientSecretItemId).toBe(
      migratedItemId("user-org:user_U:org_X", "linear-client-secret"),
    );

    // Secret ops: access, refresh, client-secret, apikey, + the orphan.
    const roles = plan.secretOps.map((o) => o.role).sort();
    expect(roles).toEqual(["apikey", "client-secret", "oauth-access", "oauth-refresh", "orphan"]);
    expect(plan.secretOps.find((o) => o.role === "orphan")?.itemId).toBe(
      migratedItemId("org_X", "loose-pat"),
    );

    // Policies: live one transforms; dead one kept inert.
    const live = plan.policies.find((p) => p.action === "approve");
    const dead = plan.policies.find((p) => p.action === "block");
    expect(live?.pattern).toBe("stripe_api.*.*.charges.create");
    expect(live?.status).toBe("ok");
    expect(dead?.status).toBe("dead-inert");
    expect(dead?.pattern).toBe("deadsource.delete"); // unchanged → matches no v2 address

    expect(plan.report.connections).toBe(2);
    expect(plan.report.oauthClients).toBe(1);
    expect(plan.report.policies).toEqual({ ok: 1, static: 0, deadInert: 1 });
  });

  it("uses discovered MCP OAuth resource overrides instead of stale provider state", () => {
    const input: MigrationInput = {
      nowMs: now,
      sources: [
        { scopeId: "user-org:user_U:org_X", id: "linear_mcp", pluginId: "mcp", name: "Linear MCP" },
      ],
      migratedConfigs: new Map([
        [
          "user-org:user_U:org_X linear_mcp",
          cfg({
            slotToTemplateSlug: { "auth:oauth2:connection": "oauth2" },
            slotToVariable: { "auth:oauth2:connection": "token" },
          }),
        ],
      ]),
      oauthResourceOverrides: new Map([
        ["user-org:user_U:org_X linear_mcp", "https://mcp.linear.app/mcp"],
      ]),
      connections: [
        {
          id: "linear-oauth",
          scopeId: "user-org:user_U:org_X",
          provider: "workos-vault",
          identityLabel: "Linear MCP OAuth",
          accessTokenSecretId: "linear-access",
          refreshTokenSecretId: "linear-refresh",
          expiresAt: 555,
          providerState: {
            kind: "dynamic-dcr",
            clientId: "cid-linear",
            tokenEndpoint: "https://mcp.linear.app/token",
            authorizationServerUrl: "https://mcp.linear.app/authorize",
            resource: "https://mcp.linear.app",
          },
        },
      ],
      bindings: [
        {
          scopeId: "user-org:user_U:org_X",
          sourceId: "linear_mcp",
          slotKey: "auth:oauth2:connection",
          kind: "connection",
          secretId: null,
          connectionId: "linear-oauth",
          textValue: null,
        },
      ],
      secrets: [
        {
          id: "linear-access",
          scopeId: "user-org:user_U:org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: "linear-oauth",
        },
        {
          id: "linear-refresh",
          scopeId: "user-org:user_U:org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: "linear-oauth",
        },
      ],
      policies: [],
      toolSourceIds: [],
    };

    const plan = planMigration(input);

    expect(plan.oauthClients).toHaveLength(1);
    expect(plan.oauthClients[0]?.resource).toBe("https://mcp.linear.app/mcp");
  });

  it("rewrites legacy Microsoft Graph policies only for tenants migrated to the curated slug", () => {
    const curatedSlug = "microsoft_graph_v1_0_sharepoint_files_excel_outlook_combined_curated";
    const input: MigrationInput = {
      nowMs: now,
      sources: [
        {
          scopeId: "org_CURATED",
          id: curatedSlug,
          pluginId: "openapi",
          name: "Microsoft Graph Curated",
        },
        {
          scopeId: "org_LEGACY",
          id: "microsoft_graph",
          pluginId: "openapi",
          name: "Microsoft Graph",
        },
      ],
      migratedConfigs: new Map([
        [`org_CURATED ${curatedSlug}`, cfg()],
        ["org_LEGACY microsoft_graph", cfg()],
      ]),
      connections: [],
      bindings: [],
      secrets: [],
      policies: [
        {
          scopeId: "org_CURATED",
          pattern: "microsoft_graph.meMessage.meDeleteMessages",
          action: "block",
        },
        {
          scopeId: "org_LEGACY",
          pattern: "microsoft_graph.meMessage.meDeleteMessages",
          action: "block",
        },
      ],
      toolSourceIds: [],
    };

    const plan = planMigration(input);

    expect(plan.policies.map((p) => p.pattern)).toEqual([
      `${curatedSlug}.*.*.meMessage.meDeleteMessages`,
      "microsoft_graph.*.*.meMessage.meDeleteMessages",
    ]);
    expect(plan.report.policies).toEqual({ ok: 2, static: 0, deadInert: 0 });
  });

  // The prod Microsoft shape: v1 stored only a bare issuer origin plus the
  // full token endpoint (no discrete authorize endpoint — v1 discovered it at
  // runtime). A bare origin is a dead authorize URL (sign-in completes but
  // never redirects back), so the planner must derive the same-origin
  // `…/authorize` sibling of the token endpoint instead.
  it("derives the authorize endpoint from the token endpoint when v1 only stored a bare issuer", () => {
    const input: MigrationInput = {
      nowMs: now,
      sources: [
        { scopeId: "org_X", id: "microsoft_graph", pluginId: "openapi", name: "Microsoft Graph" },
      ],
      migratedConfigs: new Map([
        [
          "org_X microsoft_graph",
          cfg({
            slotToTemplateSlug: { "oauth2:azureaddelegated:connection": "azureAdDelegated" },
            slotToVariable: { "oauth2:azureaddelegated:connection": "token" },
          }),
        ],
      ]),
      connections: [
        {
          id: "openapi-oauth-microsoft-graph",
          scopeId: "org_X",
          provider: "oauth2",
          identityLabel: null,
          accessTokenSecretId: "ms-access",
          refreshTokenSecretId: null,
          expiresAt: null,
          providerState: {
            kind: "authorization-code",
            clientId: "cid-ms",
            issuerUrl: "https://login.microsoftonline.com",
            tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            scopes: ["User.Read"],
          },
        },
      ],
      bindings: [
        {
          scopeId: "org_X",
          sourceId: "microsoft_graph",
          slotKey: "oauth2:azureaddelegated:connection",
          kind: "connection",
          secretId: null,
          connectionId: "openapi-oauth-microsoft-graph",
          textValue: null,
        },
      ],
      secrets: [
        {
          id: "ms-access",
          scopeId: "org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: "openapi-oauth-microsoft-graph",
        },
      ],
      policies: [],
      toolSourceIds: [],
    };

    const plan = planMigration(input);

    expect(plan.oauthClients).toHaveLength(1);
    expect(plan.oauthClients[0]?.authorizationUrl).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(plan.oauthClients[0]?.tokenUrl).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    );
  });

  // v2 produces tools per connection, so a no-auth source (no credential
  // bindings at all) must still get its canonical connection — template
  // "none", empty item_ids — or the migrated integration is dead.
  it("plans a workspace none-template connection for binding-less no-auth sources", () => {
    const input: MigrationInput = {
      nowMs: now,
      sources: [{ scopeId: "org_X", id: "context7", pluginId: "mcp", name: "Context7" }],
      migratedConfigs: new Map([
        ["org_X context7", cfg({ config: { transport: "remote", auth: { kind: "none" } } })],
      ]),
      connections: [],
      bindings: [],
      secrets: [],
      policies: [],
      toolSourceIds: [],
    };

    const plan = planMigration(input);

    expect(plan.connections).toHaveLength(1);
    const conn = plan.connections[0];
    expect(conn?.row.integration).toBe("context7");
    expect(conn?.row.name).toBe("workspace");
    expect(conn?.row.template).toBe("none");
    expect(conn?.row.owner).toBe("org");
    expect(conn?.itemIds).toEqual({});
    // An OAuth-protected source must NOT get one.
    const oauthInput: MigrationInput = {
      ...input,
      migratedConfigs: new Map([
        ["org_X context7", cfg({ config: { transport: "remote", auth: { kind: "oauth2" } } })],
      ]),
    };
    expect(planMigration(oauthInput).connections).toHaveLength(0);
  });

  it("skips secret-binding groups whose bindings reference no secrets, with a warning", () => {
    const input: MigrationInput = {
      nowMs: now,
      sources: [{ scopeId: "org_X", id: "broken_api", pluginId: "openapi", name: "Broken" }],
      migratedConfigs: new Map(),
      connections: [],
      bindings: [
        {
          scopeId: "org_X",
          sourceId: "broken_api",
          slotKey: "header:authorization",
          kind: "secret",
          secretId: null,
          connectionId: null,
          textValue: null,
        },
      ],
      secrets: [],
      policies: [],
      toolSourceIds: [],
    };

    const plan = planMigration(input);

    // No empty-item_ids ghost connection (the runtime would refuse it tools).
    expect(plan.connections).toHaveLength(0);
    expect(plan.report.warnings.some((w) => w.includes("reference no secrets"))).toBe(true);
  });

  it("keys text-binding item ids by source so same-slot bindings do not collide", () => {
    const binding = (sourceId: string, textValue: string) => ({
      scopeId: "org_X",
      sourceId,
      slotKey: "header:authorization",
      kind: "text" as const,
      secretId: null,
      connectionId: null,
      textValue,
    });
    const input: MigrationInput = {
      nowMs: now,
      sources: [
        { scopeId: "org_X", id: "api_one", pluginId: "mcp", name: "One" },
        { scopeId: "org_X", id: "api_two", pluginId: "mcp", name: "Two" },
      ],
      migratedConfigs: new Map(),
      connections: [],
      bindings: [binding("api_one", "value-one"), binding("api_two", "value-two")],
      secrets: [],
      policies: [],
      toolSourceIds: [],
    };

    const plan = planMigration(input);

    const ids = plan.connections.map((c) => Object.values(c.itemIds)).flat();
    expect(new Set(ids).size).toBe(2);
    const ops = plan.secretOps.filter((o) => o.role === "apikey");
    expect(ops.map((o) => "fromText" in o && o.fromText).sort()).toEqual([
      "value-one",
      "value-two",
    ]);
  });

  it("plans a v1 client-credentials OAuth connection with secret-backed client credentials", () => {
    const input: MigrationInput = {
      nowMs: now,
      sources: [{ scopeId: "org_X", id: "dealcloud_api", pluginId: "openapi", name: "DealCloud" }],
      migratedConfigs: new Map([
        [
          "org_X dealcloud_api",
          cfg({
            slotToTemplateSlug: { "oauth2:dealcloudoauth:connection": "dealCloudOAuth" },
            slotToVariable: { "oauth2:dealcloudoauth:connection": "token" },
          }),
        ],
      ]),
      connections: [
        {
          id: "dealcloud-oauth",
          scopeId: "org_X",
          provider: "workos-vault",
          identityLabel: "DealCloud API",
          accessTokenSecretId: "dealcloud-access",
          refreshTokenSecretId: null,
          expiresAt: null,
          providerState: {
            kind: "client-credentials",
            clientIdSecretId: "dealcloud-client-id",
            clientSecretSecretId: "dealcloud-client-secret",
            tokenEndpoint: "https://tenant.dealcloud.example/oauth/token",
            resource: "https://api.dealcloud.com",
            scopes: ["data", "reporting"],
          },
        },
      ],
      bindings: [
        {
          scopeId: "org_X",
          sourceId: "dealcloud_api",
          slotKey: "oauth2:dealcloudoauth:connection",
          kind: "connection",
          secretId: null,
          connectionId: "dealcloud-oauth",
          textValue: null,
        },
      ],
      secrets: [
        {
          id: "dealcloud-access",
          scopeId: "org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: "dealcloud-oauth",
        },
        {
          id: "dealcloud-client-id",
          scopeId: "org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: null,
        },
        {
          id: "dealcloud-client-secret",
          scopeId: "org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: null,
        },
      ],
      policies: [],
      toolSourceIds: [],
    };

    const plan = planMigration(input);

    expect(plan.oauthClients).toHaveLength(1);
    expect(plan.oauthClients[0]).toMatchObject({
      slug: "dealcloud",
      clientId: "",
      clientIdSecretRef: {
        scopeId: "org_X",
        secretId: "dealcloud-client-id",
        provider: "workos-vault",
      },
      grant: "client_credentials",
      tokenUrl: "https://tenant.dealcloud.example/oauth/token",
      authorizationUrl: "",
      resource: "https://api.dealcloud.com",
      clientSecretItemId: migratedItemId("org_X", "dealcloud-client-secret"),
    });

    const connection = plan.connections[0];
    expect(connection?.row.template).toBe("dealCloudOAuth");
    expect(connection?.row.oauthClientSlug).toBe("dealcloud");
    expect(connection?.row.oauthClientOwner).toBe("org");
    expect(connection?.row.oauthScope).toBe("data reporting");
    expect(connection?.row.expiresAt).toBe(now + SYNTHETIC_CLIENT_CREDENTIALS_TTL_MS);
    expect(connection?.refreshItemId).toBeNull();
    expect(connection?.itemIds.token).toBe(migratedItemId("org_X", "dealcloud-access"));
    expect(plan.secretOps.map((op) => op.role).sort()).toEqual(["client-secret", "oauth-access"]);
    expect(plan.report.warnings).toEqual([]);
  });

  it("does not turn oauth client credential bindings into visible api-key connections", () => {
    const input: MigrationInput = {
      nowMs: now,
      sources: [{ scopeId: "org_X", id: "spotify_web_api", pluginId: "openapi", name: "Spotify" }],
      migratedConfigs: new Map([
        [
          "org_X spotify_web_api",
          cfg({
            slotToTemplateSlug: { "oauth2:oauth-2-0:connection": "oauth_2_0" },
            slotToVariable: { "oauth2:oauth-2-0:connection": "token" },
          }),
        ],
      ]),
      connections: [
        {
          id: "spotify-oauth",
          scopeId: "user-org:user_U:org_X",
          provider: "oauth2",
          identityLabel: "Spotify Web API OAuth",
          accessTokenSecretId: "spotify-access",
          refreshTokenSecretId: "spotify-refresh",
          expiresAt: 123,
          providerState: {
            kind: "authorization-code",
            clientIdSecretId: "spotify-client-id",
            clientSecretSecretId: "spotify-client-secret",
            clientIdSecretScopeId: "org_X",
            clientSecretSecretScopeId: "org_X",
            tokenEndpoint: "https://accounts.spotify.com/api/token",
            issuerUrl: "https://accounts.spotify.com",
            scopes: ["user-read-email"],
          },
        },
      ],
      bindings: [
        {
          scopeId: "org_X",
          sourceId: "spotify_web_api",
          slotKey: "oauth2:oauth-2-0:client-id",
          kind: "secret",
          secretId: "spotify-client-id",
          connectionId: null,
          textValue: null,
        },
        {
          scopeId: "org_X",
          sourceId: "spotify_web_api",
          slotKey: "oauth2:oauth-2-0:client-secret",
          kind: "secret",
          secretId: "spotify-client-secret",
          connectionId: null,
          textValue: null,
        },
        {
          scopeId: "user-org:user_U:org_X",
          sourceScopeId: "org_X",
          sourceId: "spotify_web_api",
          slotKey: "oauth2:oauth-2-0:connection",
          kind: "connection",
          secretId: null,
          connectionId: "spotify-oauth",
          textValue: null,
        },
      ],
      secrets: [
        {
          id: "spotify-access",
          scopeId: "user-org:user_U:org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: "spotify-oauth",
        },
        {
          id: "spotify-refresh",
          scopeId: "user-org:user_U:org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: "spotify-oauth",
        },
        {
          id: "spotify-client-id",
          scopeId: "org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: null,
        },
        {
          id: "spotify-client-secret",
          scopeId: "org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: null,
        },
      ],
      policies: [],
      toolSourceIds: [],
    };

    const plan = planMigration(input);

    expect(plan.connections).toHaveLength(1);
    expect(plan.connections[0]?.row.owner).toBe("user");
    expect(plan.connections[0]?.row.template).toBe("oauth_2_0");
    expect(plan.connections[0]?.row.oauthClientSlug).toBe("spotify");
    expect(plan.connections[0]?.itemIds.token).toBe(
      migratedItemId("user-org:user_U:org_X", "spotify-access"),
    );
    expect(plan.connections[0]?.refreshItemId).toBe(
      migratedItemId("user-org:user_U:org_X", "spotify-refresh"),
    );
    expect(plan.oauthClients[0]).toMatchObject({
      slug: "spotify",
      clientIdSecretRef: {
        scopeId: "org_X",
        secretId: "spotify-client-id",
        provider: "workos-vault",
      },
      clientSecretItemId: migratedItemId("org_X", "spotify-client-secret"),
    });
    expect(plan.secretOps.map((op) => op.role).sort()).toEqual([
      "client-secret",
      "oauth-access",
      "oauth-refresh",
    ]);
  });

  it("resolves legacy client credential secret ids from the source scope for personal bindings", () => {
    const input: MigrationInput = {
      nowMs: now,
      sources: [{ scopeId: "org_X", id: "dealcloud_api", pluginId: "openapi", name: "DealCloud" }],
      migratedConfigs: new Map([
        [
          "org_X dealcloud_api",
          cfg({
            slotToTemplateSlug: { "oauth2:dealcloudoauth:connection": "dealCloudOAuth" },
            slotToVariable: { "oauth2:dealcloudoauth:connection": "token" },
          }),
        ],
      ]),
      connections: [
        {
          id: "personal-dealcloud-oauth",
          scopeId: "user-org:user_U:org_X",
          provider: "workos-vault",
          identityLabel: "DealCloud API",
          accessTokenSecretId: "dealcloud-access",
          refreshTokenSecretId: null,
          expiresAt: null,
          providerState: {
            kind: "client-credentials",
            clientIdSecretId: "dealcloud-client-id",
            clientSecretSecretId: "dealcloud-client-secret",
            tokenEndpoint: "https://tenant.dealcloud.example/oauth/token",
          },
        },
      ],
      bindings: [
        {
          scopeId: "user-org:user_U:org_X",
          sourceScopeId: "org_X",
          sourceId: "dealcloud_api",
          slotKey: "oauth2:dealcloudoauth:connection",
          kind: "connection",
          secretId: null,
          connectionId: "personal-dealcloud-oauth",
          textValue: null,
        },
      ],
      secrets: [
        {
          id: "dealcloud-access",
          scopeId: "user-org:user_U:org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: "personal-dealcloud-oauth",
        },
        {
          id: "dealcloud-client-id",
          scopeId: "org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: null,
        },
        {
          id: "dealcloud-client-secret",
          scopeId: "org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: null,
        },
      ],
      policies: [],
      toolSourceIds: [],
    };

    const plan = planMigration(input);

    expect(plan.oauthClients[0]).toMatchObject({
      ownerKeys: {
        owner: "user",
        subject: "user_U",
        tenant: "org_X",
      },
      clientIdSecretRef: {
        scopeId: "org_X",
        secretId: "dealcloud-client-id",
        provider: "workos-vault",
      },
      clientSecretItemId: migratedItemId("org_X", "dealcloud-client-secret"),
    });
    expect(plan.secretOps.find((op) => op.role === "client-secret")).toMatchObject({
      itemId: migratedItemId("org_X", "dealcloud-client-secret"),
      fromSecret: {
        scopeId: "org_X",
        secretId: "dealcloud-client-secret",
        provider: "workos-vault",
      },
    });
    expect(plan.connections[0]?.row.owner).toBe("user");
    expect(plan.connections[0]?.itemIds.token).toBe(
      migratedItemId("user-org:user_U:org_X", "dealcloud-access"),
    );
    expect(plan.report.warnings).toEqual([]);
  });

  it("keeps metadata-producing secret ops for the same item id in different owner partitions", () => {
    const input: MigrationInput = {
      nowMs: now,
      sources: [{ scopeId: "org_X", id: "dealcloud_api", pluginId: "openapi", name: "DealCloud" }],
      migratedConfigs: new Map([
        [
          "org_X dealcloud_api",
          cfg({
            slotToTemplateSlug: { "oauth2:dealcloudoauth:connection": "dealCloudOAuth" },
            slotToVariable: { "oauth2:dealcloudoauth:connection": "token" },
          }),
        ],
      ]),
      connections: [
        {
          id: "org-dealcloud-oauth",
          scopeId: "org_X",
          provider: "workos-vault",
          identityLabel: "DealCloud API",
          accessTokenSecretId: "org-access",
          refreshTokenSecretId: null,
          expiresAt: null,
          providerState: {
            kind: "client-credentials",
            clientId: "client-id",
            clientSecretSecretId: "shared-client-secret",
            tokenEndpoint: "https://tenant.dealcloud.example/oauth/token",
          },
        },
        {
          id: "personal-dealcloud-oauth",
          scopeId: "user-org:user_U:org_X",
          provider: "workos-vault",
          identityLabel: "DealCloud API",
          accessTokenSecretId: "personal-access",
          refreshTokenSecretId: null,
          expiresAt: null,
          providerState: {
            kind: "client-credentials",
            clientId: "client-id",
            clientSecretSecretId: "shared-client-secret",
            tokenEndpoint: "https://tenant.dealcloud.example/oauth/token",
          },
        },
      ],
      bindings: [
        {
          scopeId: "org_X",
          sourceId: "dealcloud_api",
          slotKey: "oauth2:dealcloudoauth:connection",
          kind: "connection",
          secretId: null,
          connectionId: "org-dealcloud-oauth",
          textValue: null,
        },
        {
          scopeId: "user-org:user_U:org_X",
          sourceScopeId: "org_X",
          sourceId: "dealcloud_api",
          slotKey: "oauth2:dealcloudoauth:connection",
          kind: "connection",
          secretId: null,
          connectionId: "personal-dealcloud-oauth",
          textValue: null,
        },
      ],
      secrets: [
        {
          id: "org-access",
          scopeId: "org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: "org-dealcloud-oauth",
        },
        {
          id: "personal-access",
          scopeId: "user-org:user_U:org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: "personal-dealcloud-oauth",
        },
        {
          id: "shared-client-secret",
          scopeId: "org_X",
          name: "",
          provider: "workos-vault",
          ownedByConnectionId: null,
        },
      ],
      policies: [],
      toolSourceIds: [],
    };

    const plan = planMigration(input);
    const clientSecretOps = plan.secretOps.filter((op) => op.role === "client-secret");

    expect(clientSecretOps).toHaveLength(2);
    expect(clientSecretOps.map((op) => op.itemId)).toEqual([
      migratedItemId("org_X", "shared-client-secret"),
      migratedItemId("org_X", "shared-client-secret"),
    ]);
    expect(clientSecretOps.map((op) => `${op.owner.owner}:${op.owner.subject}`).sort()).toEqual([
      "org:",
      "user:user_U",
    ]);
    expect(plan.secretOps.map((op) => op.role).sort()).toEqual([
      "client-secret",
      "client-secret",
      "oauth-access",
      "oauth-access",
    ]);
  });

  it("uses source_scope_id for templates and secret_scope_id for shared secret values", () => {
    const input: MigrationInput = {
      nowMs: now,
      sources: [{ scopeId: "org_X", id: "shared_api", pluginId: "openapi", name: "Shared API" }],
      migratedConfigs: new Map([
        [
          "org_X shared_api",
          cfg({
            slotToTemplateSlug: { "header:authorization": "bearer" },
            slotToVariable: { "header:authorization": "token" },
          }),
        ],
      ]),
      connections: [],
      bindings: [
        {
          scopeId: "user-org:user_U:org_X",
          sourceScopeId: "org_X",
          sourceId: "shared_api",
          slotKey: "header:authorization",
          kind: "secret",
          secretId: "shared-key",
          secretScopeId: "org_X",
          connectionId: null,
          textValue: null,
        },
      ],
      secrets: [
        {
          id: "shared-key",
          scopeId: "org_X",
          name: "Shared key",
          provider: "workos-vault",
          ownedByConnectionId: null,
        },
      ],
      policies: [],
      toolSourceIds: [],
    };

    const plan = planMigration(input);
    expect(plan.integrations.map((row) => [row.slug, row.owner, row.subject])).toEqual([
      ["shared_api", "org", ""],
    ]);
    expect(plan.connections).toHaveLength(1);
    expect(plan.connections[0]?.sourceScopeId).toBe("org_X");
    expect(plan.connections[0]?.row.name).toBe("sharedKey");
    expect(plan.connections[0]?.row.owner).toBe("user");
    expect(plan.connections[0]?.row.template).toBe("bearer");
    expect(plan.connections[0]?.itemIds.token).toBe(migratedItemId("org_X", "shared-key"));
    expect(plan.secretOps[0]?.fromSecret?.scopeId).toBe("org_X");
  });

  it("keeps the generic api-key name for multi-secret static connections", () => {
    const input: MigrationInput = {
      nowMs: now,
      sources: [{ scopeId: "org_X", id: "datadog_api", pluginId: "openapi", name: "Datadog" }],
      migratedConfigs: new Map([
        [
          "org_X datadog_api",
          cfg({
            slotToTemplateSlug: {
              "header:x-api-key": "apiKey",
              "header:x-app-key": "apiKey",
            },
            slotToVariable: {
              "header:x-api-key": "apiKey",
              "header:x-app-key": "appKey",
            },
          }),
        ],
      ]),
      connections: [],
      bindings: [
        {
          scopeId: "org_X",
          sourceId: "datadog_api",
          slotKey: "header:x-api-key",
          kind: "secret",
          secretId: "dd-api-key",
          connectionId: null,
          textValue: null,
        },
        {
          scopeId: "org_X",
          sourceId: "datadog_api",
          slotKey: "header:x-app-key",
          kind: "secret",
          secretId: "dd-app-key",
          connectionId: null,
          textValue: null,
        },
      ],
      secrets: [
        {
          id: "dd-api-key",
          scopeId: "org_X",
          name: "Datadog API key",
          provider: "workos-vault",
          ownedByConnectionId: null,
        },
        {
          id: "dd-app-key",
          scopeId: "org_X",
          name: "Datadog app key",
          provider: "workos-vault",
          ownedByConnectionId: null,
        },
      ],
      policies: [],
      toolSourceIds: [],
    };

    const plan = planMigration(input);

    expect(plan.connections).toHaveLength(1);
    expect(plan.connections[0]?.row.name).toBe("api-key");
    expect(plan.connections[0]?.itemIds).toEqual({
      apiKey: migratedItemId("org_X", "dd-api-key"),
      appKey: migratedItemId("org_X", "dd-app-key"),
    });
  });
});
