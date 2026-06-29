import { describe, expect, it } from "@effect/vitest";
import type { AuthTemplateEditorValue } from "@executor-js/react/components/auth-template-editor";

import {
  authMethodsFromConfig,
  editorValueFromGraphqlAuthMethod,
  graphqlAuthMethodInputFromEditorValue,
  graphqlAuthMethodInputsFromPlacements,
} from "./auth-method-config";

describe("graphqlAuthMethodInputFromEditorValue", () => {
  it("maps 'none' → { kind: 'none' }", () => {
    expect(graphqlAuthMethodInputFromEditorValue({ kind: "none" })).toEqual({ kind: "none" });
  });

  it("maps 'oauth' → { kind: 'oauth2' } (graphql oauth stores no endpoints)", () => {
    const value: AuthTemplateEditorValue = {
      kind: "oauth",
      authorizationUrl: "https://a.example.com/auth",
      tokenUrl: "https://a.example.com/token",
      scopes: ["read"],
    };
    expect(graphqlAuthMethodInputFromEditorValue(value)).toEqual({ kind: "oauth2" });
  });

  it("maps a header placement to an apikey method (prefix preserved)", () => {
    const value: AuthTemplateEditorValue = {
      kind: "apikey",
      placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
    };
    expect(graphqlAuthMethodInputFromEditorValue(value)).toEqual({
      kind: "apikey",
      placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
    });
  });

  it("keeps EVERY named placement — header + query mix in one method", () => {
    const value: AuthTemplateEditorValue = {
      kind: "apikey",
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer " },
        { carrier: "query", name: "team_id", prefix: "" },
      ],
    };
    expect(graphqlAuthMethodInputFromEditorValue(value)).toEqual({
      kind: "apikey",
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "authorization" },
        { carrier: "query", name: "team_id", variable: "team_id" },
      ],
    });
  });

  it("drops unnamed placements and degrades to none when nothing is usable", () => {
    expect(
      graphqlAuthMethodInputFromEditorValue({
        kind: "apikey",
        placements: [{ carrier: "header", name: "  ", prefix: "" }],
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("editorValueFromGraphqlAuthMethod", () => {
  it("round-trips an apikey method, making the shared token variable explicit", () => {
    expect(
      editorValueFromGraphqlAuthMethod({
        slug: "header",
        kind: "apikey",
        placements: [{ carrier: "header", name: "X-Api-Key", prefix: "Bearer " }],
      }),
    ).toEqual({
      kind: "apikey",
      placements: [{ carrier: "header", name: "X-Api-Key", prefix: "Bearer ", variable: "token" }],
    });
  });

  it("round-trip edit preserves placement variables (sharing survives)", () => {
    const stored = {
      slug: "custom_two_spots",
      kind: "apikey",
      placements: [
        { carrier: "header", name: "X-Token" },
        { carrier: "query", name: "token" },
      ],
    } as const;
    const editor = editorValueFromGraphqlAuthMethod(stored);
    const back = graphqlAuthMethodInputFromEditorValue(editor);
    // Both placements still share the canonical `token` input (stored as
    // absent on the wire) — a round-trip must not split one credential in two.
    expect(back).toEqual({
      kind: "apikey",
      placements: [
        { carrier: "header", name: "X-Token" },
        { carrier: "query", name: "token" },
      ],
    });
  });

  it("maps oauth2 to an oauth editor value with no endpoints", () => {
    expect(editorValueFromGraphqlAuthMethod({ slug: "oauth2", kind: "oauth2" })).toEqual({
      kind: "oauth",
      authorizationUrl: "",
      tokenUrl: "",
      scopes: [],
    });
  });
});

describe("authMethodsFromConfig", () => {
  it("projects every declared method and marks custom_ slugs as custom", () => {
    const methods = authMethodsFromConfig([
      { slug: "oauth2", kind: "oauth2" },
      {
        slug: "custom_abc123",
        kind: "apikey",
        placements: [{ carrier: "header", name: "X-Api-Key" }],
      },
      { slug: "none", kind: "none" },
    ]);

    expect(
      methods.map((method) => ({
        id: method.id,
        kind: method.kind,
        source: method.source,
        template: String(method.template),
      })),
    ).toEqual([
      { id: "oauth2", kind: "oauth", source: "spec", template: "oauth2" },
      { id: "custom_abc123", kind: "apikey", source: "custom", template: "custom_abc123" },
      { id: "none", kind: "none", source: "spec", template: "none" },
    ]);
    expect(methods[0]?.oauth).toEqual({});
  });

  it("carries multi-placement methods through to the hub", () => {
    const methods = authMethodsFromConfig([
      {
        slug: "custom_mix",
        kind: "apikey",
        placements: [
          { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "api_token" },
          { carrier: "query", name: "team_id", variable: "team_id" },
        ],
      },
    ]);
    expect(methods[0]?.placements).toEqual([
      { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "api_token" },
      { carrier: "query", name: "team_id", prefix: "", variable: "team_id" },
    ]);
  });
});

describe("graphqlAuthMethodInputsFromPlacements", () => {
  it("builds ONE method carrying every named placement", () => {
    expect(
      graphqlAuthMethodInputsFromPlacements([
        { carrier: "header", name: "X-Token", prefix: "Bearer " },
        { carrier: "query", name: "team_id", prefix: "" },
      ]),
    ).toEqual([
      {
        type: "apiKey",
        headers: { "X-Token": ["Bearer ", { type: "variable", name: "x_token" }] },
        queryParams: { team_id: [{ type: "variable", name: "team_id" }] },
      },
    ]);
  });

  it("builds a query method from a query placement", () => {
    expect(
      graphqlAuthMethodInputsFromPlacements([{ carrier: "query", name: "token", prefix: "" }]),
    ).toEqual([{ type: "apiKey", queryParams: { token: [{ type: "variable", name: "token" }] } }]);
  });

  it("skips unnamed placements", () => {
    expect(
      graphqlAuthMethodInputsFromPlacements([
        { carrier: "query", name: "", prefix: "" },
        { carrier: "query", name: "token", prefix: "" },
      ]),
    ).toEqual([{ type: "apiKey", queryParams: { token: [{ type: "variable", name: "token" }] } }]);
  });

  it("is empty when no placement has a usable name", () => {
    expect(
      graphqlAuthMethodInputsFromPlacements([{ carrier: "query", name: "  ", prefix: "" }]),
    ).toEqual([]);
  });
});
