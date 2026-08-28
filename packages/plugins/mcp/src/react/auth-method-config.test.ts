import { describe, expect, it } from "@effect/vitest";
import type { AuthTemplateEditorValue } from "@executor-js/react/components/auth-template-editor";

import { parseMcpIntegrationConfig } from "../sdk/types";
import {
  authMethodsFromConfig,
  editorValueFromMcpAuthMethod,
  mcpAuthMethodInputFromEditorValue,
  mcpAuthMethodInputsFromPlacements,
} from "./auth-method-config";

describe("mcpAuthMethodInputFromEditorValue", () => {
  it("maps 'none' → { kind: 'none' }", () => {
    expect(mcpAuthMethodInputFromEditorValue({ kind: "none" })).toEqual({ kind: "none" });
  });

  it("maps declared oauth scopes while provider endpoints remain discovered", () => {
    const value: AuthTemplateEditorValue = {
      kind: "oauth",
      authorizationUrl: "https://a.example.com/auth",
      tokenUrl: "https://a.example.com/token",
      scopes: ["mcp.read"],
    };
    expect(mcpAuthMethodInputFromEditorValue(value)).toEqual({
      kind: "oauth2",
      scopes: ["mcp.read"],
    });
  });

  it("omits an empty oauth scope list so the server metadata remains authoritative", () => {
    expect(
      mcpAuthMethodInputFromEditorValue({
        kind: "oauth",
        authorizationUrl: "",
        tokenUrl: "",
        scopes: [],
      }),
    ).toEqual({ kind: "oauth2" });
  });

  it("maps a header placement to an apikey method (prefix preserved)", () => {
    const value: AuthTemplateEditorValue = {
      kind: "apikey",
      placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
    };
    expect(mcpAuthMethodInputFromEditorValue(value)).toEqual({
      kind: "apikey",
      placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
    });
  });

  it("maps a query placement to an apikey method (servers like ui.sh use ?token=)", () => {
    const value: AuthTemplateEditorValue = {
      kind: "apikey",
      placements: [{ carrier: "query", name: "token", prefix: "" }],
    };
    expect(mcpAuthMethodInputFromEditorValue(value)).toEqual({
      kind: "apikey",
      placements: [{ carrier: "query", name: "token" }],
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
    expect(mcpAuthMethodInputFromEditorValue(value)).toEqual({
      kind: "apikey",
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "authorization" },
        { carrier: "query", name: "team_id", variable: "team_id" },
      ],
    });
  });

  it("drops unnamed placements and degrades to none when nothing is usable", () => {
    expect(
      mcpAuthMethodInputFromEditorValue({
        kind: "apikey",
        placements: [{ carrier: "header", name: "  ", prefix: "" }],
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("a stored oauth2 row's scope list", () => {
  const storedConfig = (method: Record<string, unknown>) => ({
    transport: "remote",
    endpoint: "https://mcp.example.com/mcp",
    authenticationTemplate: [method],
  });

  it("decodes whether the key is declared or absent", () => {
    expect(
      parseMcpIntegrationConfig(storedConfig({ slug: "oauth2", kind: "oauth2" })),
    ).not.toBeNull();
    expect(
      parseMcpIntegrationConfig(storedConfig({ slug: "oauth2", kind: "oauth2", scopes: ["mcp"] })),
    ).not.toBeNull();
  });

  it("fails the WHOLE config when the row stores an empty list", () => {
    // `scopes` is a NonEmptyArray, so `[]` is not "declares no scopes" — it is
    // an invalid row. Decoding is all-or-nothing: one such row does not
    // degrade to a scope-less oauth method, it makes the entire integration
    // config undecodable, and the integration then presents no auth method at
    // all. That is the whole reason the editor codec omits the key rather than
    // writing `[]`; this test is here so the constraint is not invisible.
    expect(
      parseMcpIntegrationConfig(storedConfig({ slug: "oauth2", kind: "oauth2", scopes: [] })),
    ).toBeNull();
  });
});

describe("editorValueFromMcpAuthMethod", () => {
  it("round-trips an apikey method, making the shared token variable explicit", () => {
    expect(
      editorValueFromMcpAuthMethod({
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
    const editor = editorValueFromMcpAuthMethod(stored);
    const back = mcpAuthMethodInputFromEditorValue(editor);
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

  it("maps oauth2 to an oauth editor value with no endpoints or scopes (discovered at connect)", () => {
    expect(
      editorValueFromMcpAuthMethod({
        slug: "oauth2",
        kind: "oauth2",
      }),
    ).toEqual({
      kind: "oauth",
      authorizationUrl: "",
      tokenUrl: "",
      scopes: [],
    });
  });

  it("round-trips declared oauth2 scopes while endpoints remain discovered", () => {
    const editor = editorValueFromMcpAuthMethod({
      slug: "oauth2",
      kind: "oauth2",
      scopes: ["mcp"],
    });

    expect(editor).toEqual({
      kind: "oauth",
      authorizationUrl: "",
      tokenUrl: "",
      scopes: ["mcp"],
    });
    expect(mcpAuthMethodInputFromEditorValue(editor)).toEqual({
      kind: "oauth2",
      scopes: ["mcp"],
    });
  });
});

describe("authMethodsFromConfig", () => {
  it("projects every declared method and marks custom_ slugs as custom", () => {
    const methods = authMethodsFromConfig(
      [
        { slug: "oauth2", kind: "oauth2" },
        {
          slug: "custom_abc123",
          kind: "apikey",
          placements: [{ carrier: "header", name: "X-Api-Key" }],
        },
        { slug: "none", kind: "none" },
      ],
      "https://mcp.example.com/mcp",
    );

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
    expect(methods[0]?.oauth?.discoveryUrl).toBe("https://mcp.example.com/mcp");
    expect(methods[0]?.oauth?.scopes).toBeUndefined();
  });

  it("carries declared oauth2 scopes through to the accounts hub", () => {
    const methods = authMethodsFromConfig(
      [{ slug: "oauth2", kind: "oauth2", scopes: ["mcp"] }],
      "https://mcp.example.com/mcp",
    );

    expect(methods[0]?.oauth).toEqual({
      discoveryUrl: "https://mcp.example.com/mcp",
      scopes: ["mcp"],
      supportsDynamicRegistration: true,
    });
  });

  it("carries multi-placement methods through to the hub", () => {
    const methods = authMethodsFromConfig(
      [
        {
          slug: "custom_mix",
          kind: "apikey",
          placements: [
            { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "api_token" },
            { carrier: "query", name: "team_id", variable: "team_id" },
          ],
        },
      ],
      "https://mcp.example.com/mcp",
    );
    expect(methods[0]?.placements).toEqual([
      { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "api_token" },
      { carrier: "query", name: "team_id", prefix: "", variable: "team_id" },
    ]);
  });
});

describe("mcpAuthMethodInputsFromPlacements", () => {
  it("builds ONE method carrying every named placement", () => {
    expect(
      mcpAuthMethodInputsFromPlacements([
        { carrier: "header", name: "X-Token", prefix: "Bearer " },
        { carrier: "query", name: "team_id", prefix: "" },
      ]),
    ).toEqual([
      {
        kind: "apikey",
        placements: [
          { carrier: "header", name: "X-Token", prefix: "Bearer ", variable: "x_token" },
          { carrier: "query", name: "team_id", variable: "team_id" },
        ],
      },
    ]);
  });

  it("builds a query method from a query placement (the ui.sh '?token=' case)", () => {
    expect(
      mcpAuthMethodInputsFromPlacements([{ carrier: "query", name: "token", prefix: "" }]),
    ).toEqual([{ kind: "apikey", placements: [{ carrier: "query", name: "token" }] }]);
  });

  it("skips unnamed placements", () => {
    expect(
      mcpAuthMethodInputsFromPlacements([
        { carrier: "query", name: "", prefix: "" },
        { carrier: "query", name: "token", prefix: "" },
      ]),
    ).toEqual([{ kind: "apikey", placements: [{ carrier: "query", name: "token" }] }]);
  });

  it("is empty when no placement has a usable name", () => {
    expect(
      mcpAuthMethodInputsFromPlacements([{ carrier: "query", name: "  ", prefix: "" }]),
    ).toEqual([]);
  });
});
