import { describe, expect, it } from "@effect/vitest";
import { IntegrationSlug, type IntegrationConfig, type IntegrationRecord } from "@executor-js/sdk";

import { describeMcpAuthMethods, describeMcpIntegrationDisplay } from "./plugin";

// ---------------------------------------------------------------------------
// `describeMcpAuthMethods` projects the stored MCP config into the catalog's
// plugin-agnostic `AuthMethodDescriptor[]`, one per declared method. It is
// pure/sync and must tolerate a malformed or foreign config blob by returning
// `[]`. Legacy configs (singular `auth`, or no auth field at all) are lifted
// into a one-element `authenticationTemplate` whose slug is the method kind.
// ---------------------------------------------------------------------------

const recordWith = (config: IntegrationConfig): IntegrationRecord => ({
  slug: IntegrationSlug.make("server"),
  description: "Server",
  kind: "mcp",
  canRemove: true,
  canRefresh: true,
  authMethods: [],
  config,
});

describe("describeMcpAuthMethods", () => {
  it("projects an oauth2 method carrying the discovery URL", () => {
    const methods = describeMcpAuthMethods(
      recordWith({
        transport: "remote",
        endpoint: "https://x.example/oauth/mcp",
        authenticationTemplate: [{ slug: "oauth2", kind: "oauth2" }],
      }),
    );

    expect(methods).toEqual([
      {
        id: "oauth2",
        label: "OAuth",
        kind: "oauth",
        template: "oauth2",
        oauth: {
          discoveryUrl: "https://x.example/oauth/mcp",
          supportsDynamicRegistration: true,
        },
      },
    ]);
  });

  it("projects a header method to an apikey method carrying the header placement", () => {
    const methods = describeMcpAuthMethods(
      recordWith({
        transport: "remote",
        endpoint: "https://x.example/mcp",
        authenticationTemplate: [
          { slug: "header", kind: "header", headerName: "X-Api-Key", prefix: "Bearer " },
        ],
      }),
    );

    expect(methods).toEqual([
      {
        id: "header",
        label: "API key (X-Api-Key)",
        kind: "apikey",
        template: "header",
        placements: [{ carrier: "header", name: "X-Api-Key", prefix: "Bearer " }],
      },
    ]);
  });

  it("projects every declared method (multi-method configs)", () => {
    const methods = describeMcpAuthMethods(
      recordWith({
        transport: "remote",
        endpoint: "https://x.example/mcp",
        authenticationTemplate: [
          { slug: "oauth2", kind: "oauth2" },
          { slug: "custom_abc123", kind: "header", headerName: "X-Api-Key" },
        ],
      }),
    );

    expect(methods.map((m) => ({ id: m.id, kind: m.kind, template: m.template }))).toEqual([
      { id: "oauth2", kind: "oauth", template: "oauth2" },
      { id: "custom_abc123", kind: "apikey", template: "custom_abc123" },
    ]);
  });

  it("defaults the header prefix to an empty string when unset", () => {
    const methods = describeMcpAuthMethods(
      recordWith({
        transport: "remote",
        endpoint: "https://x.example/mcp",
        authenticationTemplate: [{ slug: "header", kind: "header", headerName: "Authorization" }],
      }),
    );

    expect(methods[0]?.placements).toEqual([
      { carrier: "header", name: "Authorization", prefix: "" },
    ]);
  });

  it("projects an open (none) method to a no-auth method", () => {
    const methods = describeMcpAuthMethods(
      recordWith({
        transport: "remote",
        endpoint: "https://x.example/mcp",
        authenticationTemplate: [{ slug: "none", kind: "none" }],
      }),
    );
    expect(methods).toEqual([
      {
        id: "none",
        label: "No authentication",
        kind: "none",
        template: "none",
      },
    ]);
  });

  it("lifts a legacy singular `auth` config into one method slugged by kind", () => {
    const methods = describeMcpAuthMethods(
      recordWith({
        transport: "remote",
        endpoint: "https://x.example/oauth/mcp",
        auth: { kind: "oauth2" },
      }),
    );
    expect(methods).toEqual([
      {
        id: "oauth2",
        label: "OAuth",
        kind: "oauth",
        template: "oauth2",
        oauth: {
          discoveryUrl: "https://x.example/oauth/mcp",
          supportsDynamicRegistration: true,
        },
      },
    ]);
  });

  it("treats legacy remote configs with no auth field as open/no-auth", () => {
    const methods = describeMcpAuthMethods(
      recordWith({
        transport: "remote",
        endpoint: "https://x.example/mcp",
      }),
    );
    expect(methods).toEqual([
      {
        id: "none",
        label: "No authentication",
        kind: "none",
        template: "none",
      },
    ]);
  });

  it("returns [] for a stdio transport", () => {
    const methods = describeMcpAuthMethods(
      recordWith({ transport: "stdio", command: "run-server" }),
    );
    expect(methods).toEqual([]);
  });

  it("returns [] for a malformed / foreign config blob", () => {
    expect(describeMcpAuthMethods(recordWith({ not: "an mcp config" }))).toEqual([]);
    expect(describeMcpAuthMethods(recordWith(null))).toEqual([]);
    expect(describeMcpAuthMethods(recordWith("garbage"))).toEqual([]);
  });

  it("projects remote endpoint as display metadata", () => {
    expect(
      describeMcpIntegrationDisplay(
        recordWith({
          transport: "remote",
          endpoint: "https://mcp.posthog.com/mcp",
          authenticationTemplate: [{ slug: "none", kind: "none" }],
        }),
      ),
    ).toEqual({ url: "https://mcp.posthog.com/mcp" });
  });

  it("does not expose display metadata for stdio or malformed configs", () => {
    expect(
      describeMcpIntegrationDisplay(recordWith({ transport: "stdio", command: "run" })),
    ).toEqual({});
    expect(describeMcpIntegrationDisplay(recordWith({ not: "mcp" }))).toEqual({});
  });
});
