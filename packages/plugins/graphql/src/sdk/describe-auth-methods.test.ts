import { describe, expect, it } from "@effect/vitest";
import { IntegrationSlug, type IntegrationConfig, type IntegrationRecord } from "@executor-js/sdk";

import { describeGraphqlAuthMethods, describeGraphqlIntegrationDisplay } from "./plugin";

// ---------------------------------------------------------------------------
// `describeGraphqlAuthMethods` projects the stored GraphQL config into the
// catalog's plugin-agnostic `AuthMethodDescriptor[]`. It is pure/sync and must
// tolerate a malformed or foreign config blob by returning `[]`. This is the
// projection that surfaces declared + custom GraphQL methods through the
// catalog's `authMethods` (GraphQL has no accounts slot of its own).
// ---------------------------------------------------------------------------

const recordWith = (config: IntegrationConfig): IntegrationRecord => ({
  slug: IntegrationSlug.make("gql"),
  description: "GraphQL",
  kind: "graphql",
  canRemove: true,
  canRefresh: true,
  authMethods: [],
  config,
});

describe("describeGraphqlAuthMethods", () => {
  it("projects a header apiKey template to one apikey method carrying the header placement", () => {
    const methods = describeGraphqlAuthMethods(
      recordWith({
        endpoint: "https://x.example/graphql",
        name: "x",
        authenticationTemplate: [
          { kind: "apiKey", slug: "api_key", in: "header", name: "X-Api-Key", prefix: "Bearer " },
        ],
      }),
    );

    expect(methods).toEqual([
      {
        id: "api_key",
        label: "API key (X-Api-Key)",
        kind: "apikey",
        template: "api_key",
        placements: [{ carrier: "header", name: "X-Api-Key", prefix: "Bearer " }],
      },
    ]);
  });

  it("projects a query apiKey template to one apikey method carrying the query placement", () => {
    const methods = describeGraphqlAuthMethods(
      recordWith({
        endpoint: "https://x.example/graphql",
        name: "x",
        authenticationTemplate: [{ kind: "apiKey", slug: "qp", in: "query", name: "api_key" }],
      }),
    );

    expect(methods).toEqual([
      {
        id: "qp",
        label: "API key (api_key)",
        kind: "apikey",
        template: "qp",
        placements: [{ carrier: "query", name: "api_key", prefix: "" }],
      },
    ]);
  });

  it("defaults the placement prefix to an empty string when unset", () => {
    const methods = describeGraphqlAuthMethods(
      recordWith({
        endpoint: "https://x.example/graphql",
        name: "x",
        authenticationTemplate: [
          { kind: "apiKey", slug: "h", in: "header", name: "Authorization" },
        ],
      }),
    );

    expect(methods[0]?.placements).toEqual([
      { carrier: "header", name: "Authorization", prefix: "" },
    ]);
  });

  it("projects an oauth2 template to one oauth method", () => {
    const methods = describeGraphqlAuthMethods(
      recordWith({
        endpoint: "https://x.example/graphql",
        name: "x",
        authenticationTemplate: [{ kind: "oauth2", slug: "oauth" }],
      }),
    );

    expect(methods).toEqual([
      {
        id: "oauth",
        label: "OAuth",
        kind: "oauth",
        template: "oauth",
        oauth: {},
      },
    ]);
  });

  it("projects every declared method (multi-method specs)", () => {
    const methods = describeGraphqlAuthMethods(
      recordWith({
        endpoint: "https://x.example/graphql",
        name: "x",
        authenticationTemplate: [
          { kind: "apiKey", slug: "a", in: "header", name: "X-Api-Key" },
          { kind: "apiKey", slug: "b", in: "query", name: "token" },
        ],
      }),
    );

    expect(methods.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("returns [] when no auth methods are declared", () => {
    const methods = describeGraphqlAuthMethods(
      recordWith({
        endpoint: "https://x.example/graphql",
        name: "x",
        authenticationTemplate: [],
      }),
    );
    expect(methods).toEqual([]);
  });

  it("returns [] for a malformed / foreign config blob", () => {
    expect(describeGraphqlAuthMethods(recordWith({ not: "a graphql config" }))).toEqual([]);
    expect(describeGraphqlAuthMethods(recordWith(null))).toEqual([]);
    expect(describeGraphqlAuthMethods(recordWith("garbage"))).toEqual([]);
  });

  it("projects endpoint as display metadata", () => {
    expect(
      describeGraphqlIntegrationDisplay(
        recordWith({
          endpoint: "https://api.github.com/graphql",
          name: "GitHub",
          authenticationTemplate: [],
        }),
      ),
    ).toEqual({ url: "https://api.github.com/graphql" });
  });

  it("does not expose display metadata for malformed configs", () => {
    expect(describeGraphqlIntegrationDisplay(recordWith({ not: "graphql" }))).toEqual({});
  });
});
