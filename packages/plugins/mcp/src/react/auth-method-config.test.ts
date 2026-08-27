import { describe, expect, it } from "@effect/vitest";
import { OAuthClientSlug } from "@executor-js/sdk/shared";
import type { AuthTemplateEditorValue } from "@executor-js/react/components/auth-template-editor";

import {
  authMethodsFromConfig,
  editorValueFromMcpAuthMethod,
  mcpAuthMethodInputFromEditorValue,
  mcpAuthMethodInputsFromPlacements,
  mcpOAuthMethodInput,
  sameEnterpriseIdentityProvider,
} from "./auth-method-config";

describe("mcpAuthMethodInputFromEditorValue", () => {
  it("maps 'none' → { kind: 'none' }", () => {
    expect(mcpAuthMethodInputFromEditorValue({ kind: "none" })).toEqual({ kind: "none" });
  });

  it("maps 'oauth' → { kind: 'oauth2' } (endpoints/scopes are resolved at connect time)", () => {
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

// ---------------------------------------------------------------------------
// Enterprise-Managed Authorization: the per-server declaration.
//
// The declaration is a POINTER at the organization's identity-provider
// registration, and it is what puts a server on the work-identity route
// instead of per-server consent. Two things must hold or the feature silently
// stops working: it has to reach the console (a dropped pointer means the
// connect path offers ordinary consent for a managed server), and it must not
// be invented by any surface that cannot see the organization's registration.
// ---------------------------------------------------------------------------

const PROVIDER = {
  client: OAuthClientSlug.make("enterprise-identity-provider"),
  clientOwner: "org",
} as const;

describe("authMethodsFromConfig · enterprise-managed declaration", () => {
  it("carries the server's identity-provider pointer onto the rendered method", () => {
    const methods = authMethodsFromConfig(
      [{ slug: "oauth2", kind: "oauth2", enterpriseIdentityProvider: PROVIDER }],
      "https://mcp.example.com/mcp",
    );
    expect(methods[0]?.oauth?.enterpriseIdentityProvider).toEqual(PROVIDER);
  });

  it("leaves the interactive route advertised beside it", () => {
    // Declaring a provider asks the connect path to TRY the enterprise branch.
    // Whether it is taken still depends on the server advertising the grant
    // profile, so the ordinary route must remain available.
    const methods = authMethodsFromConfig(
      [{ slug: "oauth2", kind: "oauth2", enterpriseIdentityProvider: PROVIDER }],
      "https://mcp.example.com/mcp",
    );
    expect(methods[0]?.oauth?.supportsDynamicRegistration).toBe(true);
    expect(methods[0]?.oauth?.discoveryUrl).toBe("https://mcp.example.com/mcp");
  });

  it("declares nothing for an ordinary oauth2 server", () => {
    const methods = authMethodsFromConfig(
      [{ slug: "oauth2", kind: "oauth2" }],
      "https://mcp.example.com/mcp",
    );
    expect(methods[0]?.oauth?.enterpriseIdentityProvider).toBeUndefined();
  });
});

describe("mcpOAuthMethodInput", () => {
  it("attaches the organization's registration when the server is managed", () => {
    expect(mcpOAuthMethodInput(PROVIDER)).toEqual({
      kind: "oauth2",
      enterpriseIdentityProvider: PROVIDER,
    });
  });

  it("omits the key entirely when it is not — never an explicit undefined", () => {
    // `configureMcpAuth` decodes this against a union; an explicit
    // `enterpriseIdentityProvider: undefined` is a different wire value and is
    // rejected, so absence has to be real absence.
    const input = mcpOAuthMethodInput(undefined);
    expect(input).toEqual({ kind: "oauth2" });
    expect(Object.hasOwn(input, "enterpriseIdentityProvider")).toBe(false);
  });
});

describe("mcpAuthMethodInputFromEditorValue · enterprise-managed declaration", () => {
  it("invents no declaration from the credential editor", () => {
    // The editor edits credentials. Server policy is not one, and a surface
    // that cannot see the organization's registration must not guess at it —
    // the save path re-attaches it deliberately instead.
    expect(
      mcpAuthMethodInputFromEditorValue({
        kind: "oauth",
        authorizationUrl: "",
        tokenUrl: "",
        scopes: [],
      }),
    ).toEqual({ kind: "oauth2" });
  });
});

describe("sameEnterpriseIdentityProvider", () => {
  it("compares the pointer by value, not by reference", () => {
    // The stored copy is decoded from JSON, so it is never the same object as
    // the one the console just built; a reference check would report every
    // save as a change.
    expect(sameEnterpriseIdentityProvider({ ...PROVIDER }, { ...PROVIDER })).toBe(true);
  });

  it("distinguishes a different registration", () => {
    expect(sameEnterpriseIdentityProvider(PROVIDER, { ...PROVIDER, clientOwner: "user" })).toBe(
      false,
    );
    expect(
      sameEnterpriseIdentityProvider(PROVIDER, {
        ...PROVIDER,
        client: OAuthClientSlug.make("other"),
      }),
    ).toBe(false);
  });

  it("treats declaring and not declaring as different", () => {
    expect(sameEnterpriseIdentityProvider(PROVIDER, undefined)).toBe(false);
    expect(sameEnterpriseIdentityProvider(undefined, undefined)).toBe(true);
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
