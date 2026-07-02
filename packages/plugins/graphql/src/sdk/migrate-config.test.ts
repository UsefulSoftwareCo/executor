import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { migrateGraphqlAuthConfig } from "./migrate-config";
import { decodeGraphqlIntegrationConfigOption } from "./types";

// ---------------------------------------------------------------------------
// The one-off config migration rewrites every pre-canonical GraphQL blob
// family into the canonical placements model. Two invariants are load-bearing:
// slugs are preserved verbatim (connections bind by `connection.template`)
// and variable names are preserved verbatim (they key stored `item_ids`).
// ---------------------------------------------------------------------------

const BASE = { endpoint: "https://x.example/graphql", name: "x" } as const;

const decodes = (config: unknown): boolean =>
  Option.isSome(decodeGraphqlIntegrationConfigOption(config));

describe("migrateGraphqlAuthConfig", () => {
  it("lifts the v1→v2 singular `auth: {kind:'none'}` into a one-method template, slug = kind", () => {
    const migrated = migrateGraphqlAuthConfig({ ...BASE, auth: { kind: "none" } });
    expect(migrated).toEqual({
      ...BASE,
      authenticationTemplate: [{ slug: "none", kind: "none" }],
    });
    expect(decodes(migrated)).toBe(true);
  });

  it("lifts a singular `auth: {kind:'oauth2'}` (the v1→v2 migration's output)", () => {
    expect(migrateGraphqlAuthConfig({ ...BASE, auth: { kind: "oauth2" } })).toEqual({
      ...BASE,
      authenticationTemplate: [{ slug: "oauth2", kind: "oauth2" }],
    });
  });

  it("treats a config with no auth fields at all as an open endpoint", () => {
    expect(migrateGraphqlAuthConfig({ ...BASE })).toEqual({
      ...BASE,
      authenticationTemplate: [{ slug: "none", kind: "none" }],
    });
  });

  it("rewrites the retired native `{kind:'apiKey', in, name}` shape, slugs preserved", () => {
    const migrated = migrateGraphqlAuthConfig({
      ...BASE,
      authenticationTemplate: [
        { kind: "apiKey", slug: "header", in: "header", name: "X-Api-Key", prefix: "Bearer " },
        { kind: "apiKey", slug: "custom_q1", in: "query", name: "token" },
        { kind: "oauth2", slug: "oauth2" },
      ],
    });
    expect(migrated).toEqual({
      ...BASE,
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
        { kind: "oauth2", slug: "oauth2" },
      ],
    });
    expect(decodes(migrated)).toBe(true);
  });

  it("rewrites openapi-shaped entries the v1→v2 migration wrote, variables preserved", () => {
    // Exactly what `migrateOpenApiAuthTemplate` emits for a multi-input source.
    const migrated = migrateGraphqlAuthConfig({
      ...BASE,
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
        { slug: "github_oauth", type: "oauth" },
      ],
    });
    expect(migrated).toEqual({
      ...BASE,
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
        { slug: "github_oauth", kind: "oauth2" },
      ],
    });
    expect(decodes(migrated)).toBe(true);
  });

  it("stores the canonical `token` variable as absent and literal-only values as literals", () => {
    const migrated = migrateGraphqlAuthConfig({
      ...BASE,
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

  it("folds a singular oauth2 `auth` alongside apiKey entries into the declared set", () => {
    // The v1→v2 migration wrote BOTH when a source had placements and oauth.
    const migrated = migrateGraphqlAuthConfig({
      ...BASE,
      auth: { kind: "oauth2" },
      authenticationTemplate: [
        {
          slug: "apiKey",
          type: "apiKey",
          headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
        },
      ],
    });
    expect(migrated).toEqual({
      ...BASE,
      authenticationTemplate: [
        {
          slug: "apiKey",
          kind: "apikey",
          placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
        },
        { slug: "oauth2", kind: "oauth2" },
      ],
    });
    expect(decodes(migrated)).toBe(true);
  });

  it("is idempotent — a canonical config returns null (no rewrite)", () => {
    const canonical = {
      ...BASE,
      authenticationTemplate: [
        { slug: "oauth2", kind: "oauth2" },
        {
          slug: "header",
          kind: "apikey",
          placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
        },
        { slug: "none", kind: "none" },
      ],
    };
    expect(migrateGraphqlAuthConfig(canonical)).toBeNull();
    // And the lifted output of every family is itself canonical.
    const lifted = migrateGraphqlAuthConfig({ ...BASE, auth: { kind: "oauth2" } });
    expect(migrateGraphqlAuthConfig(lifted)).toBeNull();
    const liftedBoth = migrateGraphqlAuthConfig({
      ...BASE,
      auth: { kind: "oauth2" },
      authenticationTemplate: [{ kind: "apiKey", slug: "header", in: "header", name: "X-Api-Key" }],
    });
    expect(migrateGraphqlAuthConfig(liftedBoth)).toBeNull();
  });

  it("leaves foreign and unmigratable blobs untouched", () => {
    // MCP remote configs also carry an endpoint — `transport` marks them.
    expect(
      migrateGraphqlAuthConfig({ transport: "remote", endpoint: "https://x.example/mcp" }),
    ).toBeNull();
    expect(migrateGraphqlAuthConfig({ not: "graphql" })).toBeNull();
    expect(migrateGraphqlAuthConfig(null)).toBeNull();
    expect(
      migrateGraphqlAuthConfig({
        ...BASE,
        authenticationTemplate: [{ slug: "x", kind: "mystery" }],
      }),
    ).toBeNull();
    expect(migrateGraphqlAuthConfig({ ...BASE, auth: { kind: "mystery" } })).toBeNull();
  });
});
