import { describe, expect, it } from "@effect/vitest";

import { openApiPlugin } from "./plugin";
import { FIGMA_SPEC_OVERRIDES, FIGMA_SUPPORTED_OAUTH_SCOPES, openApiPresets } from "./presets";

const unsupportedFigmaOAuthScopes = [
  "file_variables:read",
  "file_variables:write",
  "files:read",
  "library_analytics:read",
] as const;

describe("OpenAPI presets", () => {
  it("narrows Figma OAuth to the supported scope set", () => {
    expect(FIGMA_SUPPORTED_OAUTH_SCOPES).toHaveLength(15);
    for (const scope of unsupportedFigmaOAuthScopes) {
      expect(FIGMA_SUPPORTED_OAUTH_SCOPES).not.toContain(scope);
    }

    const operation = FIGMA_SPEC_OVERRIDES[0];
    expect(operation).toMatchObject({
      op: "replace",
      path: "/components/securitySchemes/OAuth2/flows/authorizationCode/scopes",
      value: Object.fromEntries(FIGMA_SUPPORTED_OAUTH_SCOPES.map((scope) => [scope, ""])),
    });
  });

  it("projects Figma spec overrides through the plugin catalog", () => {
    const sdkPreset = openApiPresets.find((preset) => preset.id === "figma");
    const catalogPreset = openApiPlugin().integrationPresets?.find(
      (preset) => preset.id === "figma",
    );

    expect(sdkPreset?.specOverrides).toEqual(FIGMA_SPEC_OVERRIDES);
    expect(catalogPreset?.specOverrides).toEqual(FIGMA_SPEC_OVERRIDES);
  });
});
