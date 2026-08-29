import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { decodeOpenApiSpecOverrides } from "../sdk/spec-overrides";
import { Exit } from "effect";

import {
  composeQuickAddAuth,
  performQuickAdd,
  quickAddRequestPayloads,
  quickAddSpecPlan,
  type QuickAddDeps,
} from "./integration-plugin";

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

  it("an explicitly EMPTY preset override list suppresses the registry's", () => {
    // Presence-based, like the full page's `presetOverrides ?? registry`:
    // an empty list is a decision, not an absence.
    const registryOverrides = decodeOpenApiSpecOverrides([
      { op: "remove", path: "/components/securitySchemes/Cookie" },
    ]);
    const plan = quickAddSpecPlan(
      { id: "custom", name: "Custom", summary: "", specOverrides: [] },
      registryOverrides,
    );
    expect(plan.specOverrides).toBeUndefined();
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

describe("quickAddRequestPayloads", () => {
  it("the preview and the add carry the identical spec plan", () => {
    // The regression contract itself: reverting either call site to a bare
    // payload makes these fields diverge and this test fail.
    const plan = quickAddSpecPlan(
      {
        id: "figma",
        name: "Figma",
        summary: "",
        specFormat: "fmt",
        specOverrides: [...scopeOverride],
      },
      undefined,
    );
    const requests = quickAddRequestPayloads(
      { url: "https://example.com/spec.yaml", name: "Figma API", domain: "figma.com" },
      "figma_api",
      plan,
    );
    expect(requests.preview.specFormat).toBe("fmt");
    expect(requests.preview.specOverrides).toEqual(scopeOverride);
    expect(requests.add.specFormat).toBe(requests.preview.specFormat);
    expect(requests.add.specOverrides).toEqual(requests.preview.specOverrides);
    expect(requests.add.displayDomain).toBe("figma.com");
    expect(requests.add.spec).toEqual({ kind: "url", url: "https://example.com/spec.yaml" });
  });
});

describe("performQuickAdd", () => {
  // The OPERATION under test, with the two mutations captured — the guard
  // the review demanded twice: helper tests kept passing while a call site
  // could quietly stop using the shared plan.
  it("sends the identical spec plan to preview and add, and composed auth", async () => {
    const previews: unknown[] = [];
    const adds: unknown[] = [];
    const deps: QuickAddDeps = {
      presets: [
        {
          id: "figma",
          name: "Figma",
          summary: "",
          url: "https://example.com/spec.yaml",
          specFormat: "fmt",
          specOverrides: [...scopeOverride],
        },
      ],
      preview: (payload) => {
        previews.push(payload);
        return Promise.resolve(
          Exit.succeed({
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
                scopes: { "files:read": "" },
                identityScopes: [] as const,
              },
            ],
            servers: [{ url: "https://api.example.com" }],
          }),
        );
      },
      add: (payload) => {
        adds.push(payload);
        return Promise.resolve(Exit.succeed({ slug: "figma_api" }));
      },
    };
    const result = await performQuickAdd(deps, {
      url: "https://example.com/spec.yaml",
      name: "Figma API",
      slug: "figma-api",
      domain: "figma.com",
      authHeader: "Authorization: Bearer {token}",
    });
    expect(result).toEqual({ ok: true, slug: "figma_api" });
    expect(previews).toHaveLength(1);
    expect(adds).toHaveLength(1);
    const preview = previews[0] as Record<string, unknown>;
    const add = adds[0] as Record<string, unknown>;
    // The regression contract: BOTH real payloads carry the one spec plan.
    expect(preview.specFormat).toBe("fmt");
    expect(preview.specOverrides).toEqual(scopeOverride);
    expect(add.specFormat).toBe(preview.specFormat);
    expect(add.specOverrides).toEqual(preview.specOverrides);
    expect(add.slug).toBe("figma_api");
    expect(add.displayDomain).toBe("figma.com");
    // Auth derived from the overridden document, registry key appended.
    const template = add.authenticationTemplate as readonly unknown[];
    expect(JSON.stringify(template)).toContain("files:read");
    expect(JSON.stringify(template)).toContain("Authorization");
  });

  it("skips the preview entirely when the registry declared no header", async () => {
    const previews: unknown[] = [];
    const deps: QuickAddDeps = {
      presets: [],
      preview: (payload) => {
        previews.push(payload);
        return Promise.resolve(Exit.fail("unexpected"));
      },
      add: () => Promise.resolve(Exit.succeed({ slug: "plain" })),
    };
    const result = await performQuickAdd(deps, {
      url: "https://example.com/openapi.json",
      name: "Plain API",
    });
    expect(result).toEqual({ ok: true, slug: "plain" });
    expect(previews).toHaveLength(0);
  });
});
