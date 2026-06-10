import { describe, expect, it } from "@effect/vitest";

import { migrateMcpAuthConfig } from "./migrate-config";
import { parseMcpIntegrationConfig } from "./types";

// ---------------------------------------------------------------------------
// The one-off config migration rewrites every pre-canonical MCP blob family
// into the canonical placements model. Two invariants are load-bearing:
// slugs are preserved verbatim (connections bind by `connection.template`)
// and variable names are preserved verbatim (they key stored `item_ids`).
// ---------------------------------------------------------------------------

const REMOTE = { transport: "remote", endpoint: "https://x.example/mcp" } as const;

describe("migrateMcpAuthConfig", () => {
  it("lifts a singular `auth: {kind:'header'}` into a one-method template, slug = kind", () => {
    const migrated = migrateMcpAuthConfig({
      ...REMOTE,
      auth: { kind: "header", headerName: "Authorization", prefix: "Bearer " },
    });
    expect(migrated).toEqual({
      ...REMOTE,
      authenticationTemplate: [
        {
          slug: "header",
          kind: "apikey",
          placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
        },
      ],
    });
    expect(parseMcpIntegrationConfig(migrated)).not.toBeNull();
  });

  it("lifts a singular `auth: {kind:'oauth2'}` (the v1→v2 migration's output)", () => {
    expect(migrateMcpAuthConfig({ ...REMOTE, auth: { kind: "oauth2" } })).toEqual({
      ...REMOTE,
      authenticationTemplate: [{ slug: "oauth2", kind: "oauth2" }],
    });
  });

  it("treats a remote config with no auth field as an open server", () => {
    expect(migrateMcpAuthConfig({ ...REMOTE })).toEqual({
      ...REMOTE,
      authenticationTemplate: [{ slug: "none", kind: "none" }],
    });
  });

  it("rewrites retired single-placement `header` / `query` methods, slugs preserved", () => {
    const migrated = migrateMcpAuthConfig({
      ...REMOTE,
      authenticationTemplate: [
        { slug: "header", kind: "header", headerName: "X-Api-Key", prefix: "Bearer " },
        { slug: "custom_q1", kind: "query", paramName: "token" },
        { slug: "none", kind: "none" },
      ],
    });
    expect(migrated).toEqual({
      ...REMOTE,
      authenticationTemplate: [
        {
          slug: "header",
          kind: "apikey",
          placements: [{ carrier: "header", name: "X-Api-Key", prefix: "Bearer " }],
        },
        {
          slug: "custom_q1",
          kind: "apikey",
          placements: [{ carrier: "query", name: "token" }],
        },
        { slug: "none", kind: "none" },
      ],
    });
  });

  it("rewrites openapi-shaped entries the v1→v2 migration wrote, variables preserved", () => {
    // Exactly what `migrateOpenApiAuthTemplate` emits for a two-input source.
    const migrated = migrateMcpAuthConfig({
      ...REMOTE,
      authenticationTemplate: [
        {
          slug: "apiKey",
          type: "apiKey",
          headers: {
            "DD-API-KEY": [{ type: "variable", name: "dd_api_key" }],
            Authorization: ["Bearer ", { type: "variable", name: "dd_application_key" }],
          },
          queryParams: { team: [{ type: "variable", name: "team" }] },
        },
      ],
    });
    expect(migrated).toEqual({
      ...REMOTE,
      authenticationTemplate: [
        {
          slug: "apiKey",
          kind: "apikey",
          placements: [
            { carrier: "header", name: "DD-API-KEY", variable: "dd_api_key" },
            {
              carrier: "header",
              name: "Authorization",
              prefix: "Bearer ",
              variable: "dd_application_key",
            },
            { carrier: "query", name: "team", variable: "team" },
          ],
        },
      ],
    });
  });

  it("stores the canonical `token` variable as absent and literal-only values as literals", () => {
    const migrated = migrateMcpAuthConfig({
      ...REMOTE,
      authenticationTemplate: [
        {
          slug: "apiKey",
          type: "apiKey",
          headers: {
            Authorization: ["Bearer ", { type: "variable", name: "token" }],
            "X-Api-Version": "2023-01-01",
          },
        },
      ],
    }) as { authenticationTemplate: readonly unknown[] };
    expect(migrated.authenticationTemplate[0]).toEqual({
      slug: "apiKey",
      kind: "apikey",
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer " },
        { carrier: "header", name: "X-Api-Version", literal: "2023-01-01" },
      ],
    });
  });

  it("is idempotent — a canonical config returns null (no rewrite)", () => {
    const canonical = {
      ...REMOTE,
      authenticationTemplate: [
        { slug: "oauth2", kind: "oauth2" },
        {
          slug: "header",
          kind: "apikey",
          placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
        },
      ],
    };
    expect(migrateMcpAuthConfig(canonical)).toBeNull();
    // And the lifted output of every family is itself canonical.
    const lifted = migrateMcpAuthConfig({ ...REMOTE, auth: { kind: "oauth2" } });
    expect(migrateMcpAuthConfig(lifted)).toBeNull();
  });

  it("leaves stdio, foreign, and unmigratable blobs untouched", () => {
    expect(migrateMcpAuthConfig({ transport: "stdio", command: "run" })).toBeNull();
    expect(migrateMcpAuthConfig({ not: "mcp" })).toBeNull();
    expect(migrateMcpAuthConfig(null)).toBeNull();
    expect(
      migrateMcpAuthConfig({
        ...REMOTE,
        authenticationTemplate: [{ slug: "x", kind: "mystery" }],
      }),
    ).toBeNull();
  });
});
