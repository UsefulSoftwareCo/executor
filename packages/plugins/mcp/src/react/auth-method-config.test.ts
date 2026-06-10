import { describe, expect, it } from "@effect/vitest";
import type { AuthTemplateEditorValue } from "@executor-js/react/components/auth-template-editor";

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

  it("maps 'oauth' → { kind: 'oauth2' } (endpoints are resolved at connect time)", () => {
    const value: AuthTemplateEditorValue = {
      kind: "oauth",
      authorizationUrl: "https://a.example.com/auth",
      tokenUrl: "https://a.example.com/token",
      scopes: ["mcp.read"],
    };
    expect(mcpAuthMethodInputFromEditorValue(value)).toEqual({ kind: "oauth2" });
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

  it("maps oauth2 to an oauth editor value with no endpoints (discovered at connect)", () => {
    expect(editorValueFromMcpAuthMethod({ slug: "oauth2", kind: "oauth2" })).toEqual({
      kind: "oauth",
      authorizationUrl: "",
      tokenUrl: "",
      scopes: [],
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
