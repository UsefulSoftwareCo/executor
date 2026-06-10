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

  it("maps apiKey → a header method from the first named header placement (with prefix)", () => {
    const value: AuthTemplateEditorValue = {
      kind: "apikey",
      placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
    };
    expect(mcpAuthMethodInputFromEditorValue(value)).toEqual({
      kind: "header",
      headerName: "Authorization",
      prefix: "Bearer ",
    });
  });

  it("omits the prefix when blank", () => {
    const value: AuthTemplateEditorValue = {
      kind: "apikey",
      placements: [{ carrier: "header", name: "X-Token", prefix: "" }],
    };
    expect(mcpAuthMethodInputFromEditorValue(value)).toEqual({
      kind: "header",
      headerName: "X-Token",
    });
  });

  it("skips a query placement (MCP carries a single header) and falls back to none", () => {
    const value: AuthTemplateEditorValue = {
      kind: "apikey",
      placements: [{ carrier: "query", name: "api_key", prefix: "" }],
    };
    expect(mcpAuthMethodInputFromEditorValue(value)).toEqual({ kind: "none" });
  });

  it("uses the first NAMED header placement (skips unnamed)", () => {
    const value: AuthTemplateEditorValue = {
      kind: "apikey",
      placements: [
        { carrier: "header", name: "", prefix: "" },
        { carrier: "header", name: "X-Token", prefix: "" },
      ],
    };
    expect(mcpAuthMethodInputFromEditorValue(value)).toEqual({
      kind: "header",
      headerName: "X-Token",
    });
  });
});

describe("editorValueFromMcpAuthMethod", () => {
  it("round-trips a header method into an apikey editor value", () => {
    expect(
      editorValueFromMcpAuthMethod({
        slug: "header",
        kind: "header",
        headerName: "X-Api-Key",
        prefix: "Bearer ",
      }),
    ).toEqual({
      kind: "apikey",
      placements: [{ carrier: "header", name: "X-Api-Key", prefix: "Bearer " }],
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
        { slug: "custom_abc123", kind: "header", headerName: "X-Api-Key" },
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
});

describe("mcpAuthMethodInputsFromPlacements", () => {
  it("builds one header method from the first named header placement", () => {
    expect(
      mcpAuthMethodInputsFromPlacements([
        { carrier: "query", name: "api_key", prefix: "" },
        { carrier: "header", name: "X-Token", prefix: "Bearer " },
      ]),
    ).toEqual([{ kind: "header", headerName: "X-Token", prefix: "Bearer " }]);
  });

  it("is empty when no usable header placement exists", () => {
    expect(
      mcpAuthMethodInputsFromPlacements([{ carrier: "query", name: "api_key", prefix: "" }]),
    ).toEqual([]);
  });
});
