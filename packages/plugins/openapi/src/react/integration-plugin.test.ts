import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { decodeOpenApiSpecOverrides } from "../sdk/spec-overrides";
import { composeQuickAddAuth, quickAddSpecPlan } from "./integration-plugin";

// The quick add's composition is where review found bugs twice: first it
// suppressed spec-declared methods, then it derived auth from the unmodified
// document while adding the overridden one. These pin the contract.

const scopeOverride = decodeOpenApiSpecOverrides([
  {
    op: "replace",
    path: "/components/securitySchemes/OAuth2/flows/authorizationCode/scopes",
    value: { "files:read": "" },
  },
])!;

describe("quickAddSpecPlan", () => {
  it("uses the same effective overrides for preview and add, preset first", () => {
    const registryOverrides = decodeOpenApiSpecOverrides([
      { op: "remove", path: "/components/securitySchemes/Cookie" },
    ]);
    const plan = quickAddSpecPlan(
      {
        id: "figma",
        name: "Figma",
        summary: "",
        specFormat: "plain-ish",
        specOverrides: [...scopeOverride],
      },
      registryOverrides,
    );
    // Preset overrides win over the registry's, mirroring the full add page.
    expect(plan.specOverrides).toEqual(scopeOverride);
    expect(plan.specFormat).toBe("plain-ish");
  });

  it("falls through to registry overrides when the preset has none", () => {
    const registryOverrides = decodeOpenApiSpecOverrides([
      { op: "remove", path: "/components/securitySchemes/Cookie" },
    ]);
    const plan = quickAddSpecPlan(undefined, registryOverrides);
    expect(plan.specOverrides).toEqual(registryOverrides);
    expect(plan.specFormat).toBeUndefined();
  });
});

describe("composeQuickAddAuth", () => {
  const registryPlacement = {
    carrier: "header",
    name: "Authorization",
    prefix: "Bearer ",
  } as const;

  it("keeps override-derived OAuth scopes and appends the registry key", () => {
    // The preview reflects the OVERRIDDEN document (quickAddSpecPlan sends
    // the same overrides to preview): its oauth preset carries the replaced
    // scopes. The composed template must retain them verbatim and add the
    // registry header only because no key method was detected.
    const template = composeQuickAddAuth([], registryPlacement, {
      headerPresets: [],
      oauth2Presets: [
        {
          label: "OAuth2",
          securitySchemeName: "OAuth2",
          flow: "authorizationCode" as const,
          authorizationUrl: Option.some("https://example.com/authorize"),
          tokenUrl: "https://example.com/token",
          resource: Option.none(),
          refreshUrl: Option.none(),
          // The overridden document's scopes — the whole point: the preview
          // reflects the SAME effective spec the add stores.
          scopes: { "files:read": "" },
          identityScopes: [] as const,
        },
      ],
      servers: [{ url: "https://api.example.com" }],
    });
    expect(template).toHaveLength(2);
    const oauth = template.find((method) => "kind" in method && method.kind === "oauth2");
    expect(oauth && "scopes" in oauth ? oauth.scopes : undefined).toEqual(["files:read"]);
    const key = template.find((method) => !("kind" in method) || method.kind !== "oauth2");
    expect(JSON.stringify(key)).toContain("Authorization");
  });

  it("does not append the registry key when the spec already declares one", () => {
    const template = composeQuickAddAuth([], registryPlacement, {
      headerPresets: [
        {
          label: "API key",
          headers: { "X-API-Key": null },
          secretHeaders: ["X-API-Key"],
          secretQueryParams: [],
        },
      ],
      oauth2Presets: [],
      servers: [{ url: "https://api.example.com" }],
    });
    expect(template).toHaveLength(1);
    expect(JSON.stringify(template[0])).toContain("X-API-Key");
  });
});
