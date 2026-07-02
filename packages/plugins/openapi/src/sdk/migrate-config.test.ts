import { describe, expect, it } from "@effect/vitest";

import { renderAuthTemplate } from "./config";
import { migrateOpenApiAuthConfig } from "./migrate-config";
import type { Authentication } from "./types";

// ---------------------------------------------------------------------------
// The one-off config migration rewrites the retired `variable()`-templated
// apiKey shape into canonical placements. Slugs and variable names are
// preserved verbatim (`connection.template` / `item_ids` contracts), and the
// EQUIVALENCE tests pin that a migrated template renders byte-identically to
// what the legacy renderer produced for the same values.
// ---------------------------------------------------------------------------

const BASE = { spec: "{}", baseUrl: "https://api.example.com" } as const;

describe("migrateOpenApiAuthConfig", () => {
  it("rewrites a single-input bearer template (prefix + token)", () => {
    const migrated = migrateOpenApiAuthConfig({
      ...BASE,
      authenticationTemplate: [
        {
          slug: "bearer",
          type: "apiKey",
          headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
        },
      ],
    });
    expect(migrated).toEqual({
      ...BASE,
      authenticationTemplate: [
        {
          slug: "bearer",
          kind: "apikey",
          placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
        },
      ],
    });
  });

  it("rewrites a multi-input template (Datadog), variables preserved verbatim", () => {
    const migrated = migrateOpenApiAuthConfig({
      ...BASE,
      authenticationTemplate: [
        {
          slug: "datadog",
          type: "apiKey",
          headers: {
            "DD-API-KEY": [{ type: "variable", name: "dd_api_key" }],
            "DD-APPLICATION-KEY": [{ type: "variable", name: "dd_application_key" }],
          },
          queryParams: { site: [{ type: "variable", name: "site" }] },
        },
      ],
    });
    expect(migrated).toEqual({
      ...BASE,
      authenticationTemplate: [
        {
          slug: "datadog",
          kind: "apikey",
          placements: [
            { carrier: "header", name: "DD-API-KEY", variable: "dd_api_key" },
            { carrier: "header", name: "DD-APPLICATION-KEY", variable: "dd_application_key" },
            { carrier: "query", name: "site", variable: "site" },
          ],
        },
      ],
    });
  });

  it("rewrites literal-only template values into literal placements", () => {
    const migrated = migrateOpenApiAuthConfig({
      ...BASE,
      authenticationTemplate: [
        {
          slug: "versioned",
          type: "apiKey",
          headers: {
            "X-Api-Version": "2023-01-01",
            Authorization: ["Bearer ", { type: "variable", name: "token" }],
          },
        },
      ],
    }) as { authenticationTemplate: readonly unknown[] };
    expect(migrated.authenticationTemplate[0]).toEqual({
      slug: "versioned",
      kind: "apikey",
      placements: [
        { carrier: "header", name: "X-Api-Version", literal: "2023-01-01" },
        { carrier: "header", name: "Authorization", prefix: "Bearer " },
      ],
    });
  });

  it('re-keys the retired `type: "oauth"` spelling to `kind: "oauth2"`', () => {
    const migrated = migrateOpenApiAuthConfig({
      ...BASE,
      authenticationTemplate: [
        {
          slug: "oauth",
          type: "oauth",
          authorizationUrl: "https://x.example/auth",
          tokenUrl: "https://x.example/token",
          scopes: ["read"],
        },
        {
          slug: "key",
          type: "apiKey",
          queryParams: { key: [{ type: "variable", name: "token" }] },
        },
      ],
    }) as { authenticationTemplate: readonly unknown[] };
    expect(migrated.authenticationTemplate[0]).toEqual({
      slug: "oauth",
      kind: "oauth2",
      authorizationUrl: "https://x.example/auth",
      tokenUrl: "https://x.example/token",
      scopes: ["read"],
    });
  });

  it("is idempotent — canonical configs return null", () => {
    const canonical = {
      ...BASE,
      authenticationTemplate: [
        {
          slug: "bearer",
          kind: "apikey",
          placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
        },
      ],
    };
    expect(migrateOpenApiAuthConfig(canonical)).toBeNull();
    const lifted = migrateOpenApiAuthConfig({
      ...BASE,
      authenticationTemplate: [
        { slug: "b", type: "apiKey", headers: { A: [{ type: "variable", name: "token" }] } },
      ],
    });
    expect(migrateOpenApiAuthConfig(lifted)).toBeNull();
  });

  it("leaves template-less, foreign, and unmigratable blobs untouched", () => {
    expect(migrateOpenApiAuthConfig({ ...BASE })).toBeNull();
    expect(migrateOpenApiAuthConfig({ transport: "remote", endpoint: "x" })).toBeNull();
    expect(migrateOpenApiAuthConfig(null)).toBeNull();
    expect(
      migrateOpenApiAuthConfig({ ...BASE, authenticationTemplate: [{ garbage: true }] }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Equivalence — the migrated template renders EXACTLY what the legacy
// renderer produced. Expected outputs below are the legacy renderer's
// behavior, written out by hand so the old code can stay deleted.
// ---------------------------------------------------------------------------

describe("legacy render equivalence", () => {
  const migrateTemplate = (legacy: unknown): Authentication => {
    const migrated = migrateOpenApiAuthConfig({
      ...BASE,
      authenticationTemplate: [legacy],
    }) as { authenticationTemplate: readonly Authentication[] };
    return migrated.authenticationTemplate[0]!;
  };

  it("bearer header (prefix + token)", () => {
    const template = migrateTemplate({
      slug: "bearer",
      type: "apiKey",
      headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
    });
    expect(renderAuthTemplate(template, { token: "tok_1" })).toEqual({
      headers: { Authorization: "Bearer tok_1" },
      queryParams: {},
    });
  });

  it("two distinct inputs across headers and query (Datadog-style)", () => {
    const template = migrateTemplate({
      slug: "datadog",
      type: "apiKey",
      headers: {
        "DD-API-KEY": [{ type: "variable", name: "dd_api_key" }],
        "DD-APPLICATION-KEY": [{ type: "variable", name: "dd_application_key" }],
      },
      queryParams: { team: [{ type: "variable", name: "team" }] },
    });
    expect(
      renderAuthTemplate(template, { dd_api_key: "a", dd_application_key: "b", team: "t" }),
    ).toEqual({
      headers: { "DD-API-KEY": "a", "DD-APPLICATION-KEY": "b" },
      queryParams: { team: "t" },
    });
  });

  it("literal-only value renders verbatim with no credential", () => {
    const template = migrateTemplate({
      slug: "versioned",
      type: "apiKey",
      headers: {
        "X-Api-Version": "2023-01-01",
        Authorization: ["Bearer ", { type: "variable", name: "token" }],
      },
    });
    expect(renderAuthTemplate(template, { token: "tok_1" })).toEqual({
      headers: { "X-Api-Version": "2023-01-01", Authorization: "Bearer tok_1" },
      queryParams: {},
    });
  });

  it("bare query token (no prefix)", () => {
    const template = migrateTemplate({
      slug: "key",
      type: "apiKey",
      queryParams: { api_key: [{ type: "variable", name: "token" }] },
    });
    expect(renderAuthTemplate(template, { token: "k1" })).toEqual({
      headers: {},
      queryParams: { api_key: "k1" },
    });
  });
});
