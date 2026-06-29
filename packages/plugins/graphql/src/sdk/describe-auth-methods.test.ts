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
  it("projects a header apikey method carrying the header placement", () => {
    const methods = describeGraphqlAuthMethods(
      recordWith({
        endpoint: "https://x.example/graphql",
        name: "x",
        authenticationTemplate: [
          {
            slug: "api_key",
            kind: "apikey",
            placements: [{ carrier: "header", name: "X-Api-Key", prefix: "Bearer " }],
          },
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

  it("projects a query apikey method carrying the query placement", () => {
    const methods = describeGraphqlAuthMethods(
      recordWith({
        endpoint: "https://x.example/graphql",
        name: "x",
        authenticationTemplate: [
          { slug: "qp", kind: "apikey", placements: [{ carrier: "query", name: "api_key" }] },
        ],
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

  it("carries multi-placement methods (and their variables) through verbatim", () => {
    const methods = describeGraphqlAuthMethods(
      recordWith({
        endpoint: "https://x.example/graphql",
        name: "x",
        authenticationTemplate: [
          {
            slug: "mixed",
            kind: "apikey",
            placements: [
              {
                carrier: "header",
                name: "Authorization",
                prefix: "Bearer ",
                variable: "api_token",
              },
              { carrier: "query", name: "team_id", variable: "team_id" },
            ],
          },
        ],
      }),
    );

    expect(methods[0]?.placements).toEqual([
      { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "api_token" },
      { carrier: "query", name: "team_id", prefix: "", variable: "team_id" },
    ]);
  });

  it("defaults the placement prefix to an empty string when unset", () => {
    const methods = describeGraphqlAuthMethods(
      recordWith({
        endpoint: "https://x.example/graphql",
        name: "x",
        authenticationTemplate: [
          { slug: "h", kind: "apikey", placements: [{ carrier: "header", name: "Authorization" }] },
        ],
      }),
    );

    expect(methods[0]?.placements).toEqual([
      { carrier: "header", name: "Authorization", prefix: "" },
    ]);
  });

  it("projects an oauth2 method to one oauth descriptor", () => {
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

  it("projects a none method to a no-auth descriptor", () => {
    const methods = describeGraphqlAuthMethods(
      recordWith({
        endpoint: "https://x.example/graphql",
        name: "x",
        authenticationTemplate: [{ slug: "none", kind: "none" }],
      }),
    );

    expect(methods).toEqual([
      { id: "none", label: "No authentication", kind: "none", template: "none" },
    ]);
  });

  it("projects every declared method (multi-method specs)", () => {
    const methods = describeGraphqlAuthMethods(
      recordWith({
        endpoint: "https://x.example/graphql",
        name: "x",
        authenticationTemplate: [
          { slug: "a", kind: "apikey", placements: [{ carrier: "header", name: "X-Api-Key" }] },
          { slug: "b", kind: "apikey", placements: [{ carrier: "query", name: "token" }] },
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
