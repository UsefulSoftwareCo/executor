import { describe, expect, it } from "@effect/vitest";
import type { AuthMethodDescriptor } from "@executor-js/sdk/shared";

import { authMethodsFromDescriptors } from "./auth-placements";

describe("authMethodsFromDescriptors", () => {
  it("maps an oauth descriptor and carries discoveryUrl + supportsDynamicRegistration", () => {
    const descriptors: readonly AuthMethodDescriptor[] = [
      {
        id: "oauth2",
        label: "OAuth",
        kind: "oauth",
        template: "oauth2",
        oauth: {
          discoveryUrl: "https://mcp.example.com/oauth/mcp",
          supportsDynamicRegistration: true,
        },
      },
    ];
    const methods = authMethodsFromDescriptors(descriptors);
    expect(methods).toHaveLength(1);
    const method = methods[0]!;
    expect(method.kind).toBe("oauth");
    expect(String(method.template)).toBe("oauth2");
    expect(method.placements).toEqual([]);
    expect(method.oauth?.discoveryUrl).toBe("https://mcp.example.com/oauth/mcp");
    expect(method.oauth?.supportsDynamicRegistration).toBe(true);
  });

  it("carries pre-resolved oauth endpoints + scopes when declared (OpenAPI shape)", () => {
    const methods = authMethodsFromDescriptors([
      {
        id: "oauth",
        label: "OAuth",
        kind: "oauth",
        template: "oauth",
        oauth: {
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          resource: "https://api.example",
          scopes: ["read", "write"],
          registrationEndpoint: "https://accounts.google.com/register",
          supportsClientIdMetadataDocument: true,
        },
      },
    ]);
    expect(methods).toHaveLength(1);
    expect(methods[0]?.oauth?.authorizationUrl).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(methods[0]?.oauth?.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(methods[0]?.oauth?.resource).toBe("https://api.example");
    expect(methods[0]?.oauth?.scopes).toEqual(["read", "write"]);
    expect(methods[0]?.oauth?.registrationEndpoint).toBe("https://accounts.google.com/register");
    expect(methods[0]?.oauth?.supportsClientIdMetadataDocument).toBe(true);
  });

  it("maps an apikey/header descriptor preserving placements", () => {
    const methods = authMethodsFromDescriptors([
      {
        id: "header",
        label: "API key (header)",
        kind: "apikey",
        template: "header",
        placements: [{ carrier: "header", name: "X-Api-Key", prefix: "Bearer " }],
      },
    ]);
    expect(methods).toHaveLength(1);
    expect(methods[0]?.kind).toBe("apikey");
    expect(methods[0]?.placements).toEqual([
      { carrier: "header", name: "X-Api-Key", prefix: "Bearer " },
    ]);
  });

  it("defaults an apikey descriptor with no placements to an Authorization header", () => {
    const methods = authMethodsFromDescriptors([
      { id: "apikey", label: "API key", kind: "apikey", template: "default" },
    ]);
    expect(methods[0]?.placements).toEqual([
      { carrier: "header", name: "Authorization", prefix: "" },
    ]);
  });

  it("keeps `none` methods as no-input connection methods", () => {
    const methods = authMethodsFromDescriptors([
      { id: "none", label: "No auth", kind: "none", template: "none" },
      { id: "oauth2", label: "OAuth", kind: "oauth", template: "oauth2" },
    ]);
    expect(methods).toHaveLength(2);
    expect(methods[0]).toMatchObject({
      id: "none",
      label: "No auth",
      kind: "none",
      placements: [],
    });
    expect(String(methods[0]?.template)).toBe("none");
    expect(methods[1]?.id).toBe("oauth2");
  });

  it("returns an empty array for no descriptors", () => {
    expect(authMethodsFromDescriptors([])).toEqual([]);
  });
});
