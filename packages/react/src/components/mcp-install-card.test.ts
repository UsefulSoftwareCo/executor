import { describe, expect, it } from "@effect/vitest";

import { buildMcpHttpEndpoint, buildMcpInstallCommand, shellQuoteWord } from "./mcp-install-card";

describe("MCP install command rendering", () => {
  it("quotes shell words", () => {
    expect(shellQuoteWord("plain/path")).toBe("plain/path");
    expect(shellQuoteWord("owner's scope")).toBe(`'owner'"'"'s scope'`);
  });

  it("quotes HTTP endpoints as add-mcp arguments", () => {
    expect(
      buildMcpInstallCommand({
        origin: "http://localhost:4788",
      }),
    ).toBe("npx add-mcp http://localhost:4788/mcp --transport http --name executor");
  });

  it("renders active server authorization as an HTTP MCP header", () => {
    expect(
      buildMcpInstallCommand({
        origin: "http://127.0.0.1:4789",
        authorizationHeader: "Bearer abc123",
      }),
    ).toBe(
      "npx add-mcp http://127.0.0.1:4789/mcp --transport http --name executor --header 'Authorization: Bearer abc123'",
    );
  });

  it("uses model-managed resume by default and encodes explicit elicitation modes", () => {
    expect(
      buildMcpHttpEndpoint({
        origin: "https://executor.example",
        desktop: null,
      }),
    ).toBe("https://executor.example/mcp");

    expect(
      buildMcpInstallCommand({
        origin: "https://executor.example",
        elicitationMode: "browser",
      }),
    ).toBe(
      "npx add-mcp 'https://executor.example/mcp?elicitation_mode=browser' --transport http --name executor",
    );

    expect(
      buildMcpInstallCommand({
        origin: "https://executor.example",
        elicitationMode: "native",
      }),
    ).toBe(
      "npx add-mcp 'https://executor.example/mcp?elicitation_mode=native' --transport http --name executor",
    );
  });

  it("pins the HTTP endpoint to the org slug when one is supplied", () => {
    expect(
      buildMcpHttpEndpoint({
        origin: "https://executor.example",
        desktop: null,
        organizationSlug: "acme-corp",
      }),
    ).toBe("https://executor.example/acme-corp/mcp");

    expect(
      buildMcpInstallCommand({
        origin: "https://executor.example",
        organizationSlug: "acme-corp",
      }),
    ).toBe("npx add-mcp https://executor.example/acme-corp/mcp --transport http --name executor");
  });

  it("keeps the bare /mcp path when no org slug is supplied", () => {
    expect(
      buildMcpHttpEndpoint({
        origin: "https://executor.example",
        desktop: null,
        organizationSlug: null,
      }),
    ).toBe("https://executor.example/mcp");
  });

  it("combines the org slug with an explicit elicitation mode", () => {
    expect(
      buildMcpHttpEndpoint({
        origin: "https://executor.example",
        desktop: null,
        organizationSlug: "acme-corp",
        elicitationMode: "browser",
      }),
    ).toBe("https://executor.example/acme-corp/mcp?elicitation_mode=browser");
  });

  it("does not org-scope the desktop sidecar endpoint", () => {
    expect(
      buildMcpHttpEndpoint({
        origin: null,
        desktop: { port: 4788 },
        organizationSlug: "acme-corp",
      }),
    ).toBe("http://127.0.0.1:4788/mcp");
  });
});
