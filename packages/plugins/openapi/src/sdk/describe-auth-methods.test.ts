import { describe, expect, it } from "@effect/vitest";
import { AuthTemplateSlug } from "@executor-js/sdk/shared";
import {
  IntegrationSlug,
  type IntegrationConfig,
  type IntegrationRecord,
} from "@executor-js/sdk/core";

import { describeOpenApiAuthMethods, describeOpenApiIntegrationDisplay } from "./plugin";
import { variable, type Authentication } from "./types";

// ---------------------------------------------------------------------------
// `describeOpenApiAuthMethods` projects the stored `authenticationTemplate[]`
// into the catalog's plugin-agnostic `AuthMethodDescriptor[]` (server-side
// mirror of the client's `authMethodsFromConfig`). OpenAPI also renders its own
// accounts slot, so this is consistency work; a malformed/empty config yields
// `[]` with no regression.
// ---------------------------------------------------------------------------

const recordWith = (templates: readonly Authentication[]): IntegrationRecord => ({
  slug: IntegrationSlug.make("petstore"),
  description: "Petstore",
  kind: "openapi",
  canRemove: true,
  canRefresh: true,
  authMethods: [],
  config: { spec: "{}", authenticationTemplate: templates } as IntegrationConfig,
});

describe("describeOpenApiAuthMethods", () => {
  it("projects an apiKey header template to an apikey method with the placement prefix", () => {
    const methods = describeOpenApiAuthMethods(
      recordWith([
        {
          slug: AuthTemplateSlug.make("bearer"),
          type: "apiKey",
          headers: { Authorization: ["Bearer ", variable("token")] },
        },
      ]),
    );

    expect(methods).toEqual([
      {
        id: "bearer",
        label: "API key (Authorization)",
        kind: "apikey",
        template: "bearer",
        placements: [
          { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "token" },
        ],
      },
    ]);
  });

  it("projects an oauth template to an oauth method carrying endpoints + scopes", () => {
    const methods = describeOpenApiAuthMethods(
      recordWith([
        {
          slug: AuthTemplateSlug.make("oauth"),
          type: "oauth",
          authorizationUrl: "https://auth.example/authorize",
          tokenUrl: "https://auth.example/token",
          scopes: ["read", "write"],
        },
      ]),
    );

    expect(methods).toEqual([
      {
        id: "oauth",
        label: "OAuth2",
        kind: "oauth",
        template: "oauth",
        oauth: {
          authorizationUrl: "https://auth.example/authorize",
          tokenUrl: "https://auth.example/token",
          scopes: ["read", "write"],
        },
      },
    ]);
  });

  it("returns [] when no auth template is declared and for a foreign config", () => {
    expect(describeOpenApiAuthMethods(recordWith([]))).toEqual([]);
    expect(
      describeOpenApiAuthMethods({
        slug: IntegrationSlug.make("x"),
        description: "x",
        kind: "openapi",
        canRemove: true,
        canRefresh: true,
        authMethods: [],
        config: { not: "openapi" } as IntegrationConfig,
      }),
    ).toEqual([]);
  });

  it("projects baseUrl as display metadata", () => {
    expect(
      describeOpenApiIntegrationDisplay({
        ...recordWith([]),
        config: {
          spec: "{}",
          sourceUrl: "https://api.example.com/openapi.json",
          baseUrl: "https://api.example.com",
        } as IntegrationConfig,
      }),
    ).toEqual({ url: "https://api.example.com" });
  });

  it("falls back to sourceUrl for display metadata", () => {
    expect(
      describeOpenApiIntegrationDisplay({
        ...recordWith([]),
        config: {
          spec: "{}",
          sourceUrl: "https://api.example.com/openapi.json",
        } as IntegrationConfig,
      }),
    ).toEqual({ url: "https://api.example.com/openapi.json" });
  });
});
