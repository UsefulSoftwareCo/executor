import { describe, expect, it } from "@effect/vitest";
import { IntegrationSlug, type IntegrationConfig, type IntegrationRecord } from "@executor-js/sdk";

import { describeMcpAuthMethods, describeMcpIntegrationDisplay } from "./plugin";

// ---------------------------------------------------------------------------
// `describeMcpAuthMethods` projects the stored MCP config into the catalog's
// plugin-agnostic `AuthMethodDescriptor[]`. It is pure/sync and must tolerate a
// malformed or foreign config blob by returning `[]`.
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
  it("projects a remote oauth2 config to one oauth method carrying the discovery URL", () => {
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

  it("projects a remote header config to one apikey method carrying the header placement", () => {
    const methods = describeMcpAuthMethods(
      recordWith({
        transport: "remote",
        endpoint: "https://x.example/mcp",
        auth: { kind: "header", headerName: "X-Api-Key", prefix: "Bearer " },
      }),
    );

    expect(methods).toEqual([
      {
        id: "header",
        label: "API key (header)",
        kind: "apikey",
        template: "header",
        placements: [{ carrier: "header", name: "X-Api-Key", prefix: "Bearer " }],
      },
    ]);
  });

  it("defaults the header prefix to an empty string when unset", () => {
    const methods = describeMcpAuthMethods(
      recordWith({
        transport: "remote",
        endpoint: "https://x.example/mcp",
        auth: { kind: "header", headerName: "Authorization" },
      }),
    );

    expect(methods[0]?.placements).toEqual([
      { carrier: "header", name: "Authorization", prefix: "" },
    ]);
  });

  it("returns [] for an open (none) remote server", () => {
    const methods = describeMcpAuthMethods(
      recordWith({
        transport: "remote",
        endpoint: "https://x.example/mcp",
        auth: { kind: "none" },
      }),
    );
    expect(methods).toEqual([]);
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
          auth: { kind: "none" },
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
