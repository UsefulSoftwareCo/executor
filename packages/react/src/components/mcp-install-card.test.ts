import { describe, expect, it } from "@effect/vitest";

import {
  buildMcpHttpEndpoint,
  buildMcpInstallCommand,
  mcpInstallPreferencesStorageKey,
  shellQuoteWord,
} from "./mcp-install-card";

describe("MCP install preference storage key", () => {
  it("gives each organization its own key", () => {
    // `localStorage` is per-origin. Two orgs signed in through one browser —
    // or two people sharing a machine — must not inherit each other's
    // transport and elicitation choices, because the command they render is
    // different.
    expect(mcpInstallPreferencesStorageKey("acme")).not.toBe(
      mcpInstallPreferencesStorageKey("globex"),
    );
    expect(mcpInstallPreferencesStorageKey("acme")).toBe("executor.mcpInstallPreferences.v1.acme");
  });

  it("falls back to one bucket on hosts with no organization", () => {
    // Local and desktop are single-user and carry no org slug; they get a
    // stable key rather than an unscoped one shared with every cloud org.
    expect(mcpInstallPreferencesStorageKey(null)).toBe("executor.mcpInstallPreferences.v1.local");
    expect(mcpInstallPreferencesStorageKey(null)).not.toBe(mcpInstallPreferencesStorageKey("acme"));
  });
});

describe("MCP install command rendering", () => {
  it("quotes shell words without giving scope paths command syntax", () => {
    expect(shellQuoteWord("plain/path")).toBe("plain/path");
    expect(shellQuoteWord("owner's scope")).toBe(`'owner'"'"'s scope'`);

    const command = buildMcpInstallCommand({
      mode: "stdio",
      isDev: false,
      origin: null,
      scopeDir: `/tmp/scope"; touch /tmp/unsafe; echo "`,
    });

    expect(command).toBe(
      `npx add-mcp 'executor mcp --scope '"'"'/tmp/scope"; touch /tmp/unsafe; echo "'"'"'' --name executor`,
    );
    expect(command).not.toContain(`--scope "/tmp/scope"; touch`);
  });

  it("quotes HTTP endpoints as add-mcp arguments", () => {
    expect(
      buildMcpInstallCommand({
        mode: "http",
        isDev: false,
        origin: "http://localhost:4788",
      }),
    ).toBe("npx add-mcp http://localhost:4788/mcp --transport http --name executor");
  });

  it("renders active server authorization as an HTTP MCP header", () => {
    expect(
      buildMcpInstallCommand({
        mode: "http",
        isDev: false,
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
        mode: "http",
        isDev: false,
        origin: "https://executor.example",
        elicitationMode: "browser",
      }),
    ).toBe(
      "npx add-mcp 'https://executor.example/mcp?elicitation_mode=browser' --transport http --name executor",
    );

    expect(
      buildMcpInstallCommand({
        mode: "http",
        isDev: false,
        origin: "https://executor.example",
        elicitationMode: "native",
      }),
    ).toBe(
      "npx add-mcp 'https://executor.example/mcp?elicitation_mode=native' --transport http --name executor",
    );
  });

  // Artifacts are on by default, so only the opt-out is ever spelled out: a
  // card left alone must still produce the bare endpoint every doc and test
  // asserts.
  it("emits the artifacts opt-out only when artifacts are disabled", () => {
    expect(
      buildMcpHttpEndpoint({
        origin: "https://executor.example",
        desktop: null,
        artifacts: true,
      }),
    ).toBe("https://executor.example/mcp");

    expect(
      buildMcpHttpEndpoint({
        origin: "https://executor.example",
        desktop: null,
        artifacts: false,
      }),
    ).toBe("https://executor.example/mcp?artifacts=false");

    // Both non-defaults together, in the order the card renders them.
    expect(
      buildMcpHttpEndpoint({
        origin: "https://executor.example",
        desktop: null,
        elicitationMode: "browser",
        artifacts: false,
      }),
    ).toBe("https://executor.example/mcp?elicitation_mode=browser&artifacts=false");

    // The unknown-origin placeholder is not a parsable URL, so it is
    // concatenated rather than round-tripped through `URL`.
    expect(buildMcpHttpEndpoint({ origin: null, desktop: null, artifacts: false })).toBe(
      "<this-server>/mcp?artifacts=false",
    );
  });

  // Per-integration search tools are off by default, so only the opt-in is
  // ever spelled out: a card left alone must still produce the bare endpoint.
  it("emits the search tools opt-in only when enabled", () => {
    expect(
      buildMcpHttpEndpoint({
        origin: "https://executor.example",
        desktop: null,
        searchTools: false,
      }),
    ).toBe("https://executor.example/mcp");

    expect(
      buildMcpHttpEndpoint({
        origin: "https://executor.example",
        desktop: null,
        searchTools: true,
      }),
    ).toBe("https://executor.example/mcp?search_tools=true");

    // Both non-defaults together, in the order the card renders them.
    expect(
      buildMcpHttpEndpoint({
        origin: "https://executor.example",
        desktop: null,
        artifacts: false,
        searchTools: true,
      }),
    ).toBe("https://executor.example/mcp?artifacts=false&search_tools=true");
  });

  it("passes the search tools opt-in to the stdio CLI as a flag", () => {
    expect(
      buildMcpInstallCommand({ mode: "stdio", isDev: false, origin: null, searchTools: false }),
    ).toBe("npx add-mcp 'executor mcp' --name executor");

    expect(
      buildMcpInstallCommand({ mode: "stdio", isDev: false, origin: null, searchTools: true }),
    ).toBe("npx add-mcp 'executor mcp --search-tools' --name executor");
  });

  it("passes the artifacts opt-out to the stdio CLI as a flag", () => {
    expect(
      buildMcpInstallCommand({ mode: "stdio", isDev: false, origin: null, artifacts: true }),
    ).toBe("npx add-mcp 'executor mcp' --name executor");

    expect(
      buildMcpInstallCommand({ mode: "stdio", isDev: false, origin: null, artifacts: false }),
    ).toBe("npx add-mcp 'executor mcp --no-artifacts' --name executor");
  });

  it("passes model-managed resume through stdio install commands", () => {
    expect(
      buildMcpInstallCommand({
        mode: "stdio",
        isDev: false,
        origin: null,
        elicitationMode: "model",
      }),
    ).toBe("npx add-mcp 'executor mcp' --name executor");
  });

  it("pins dev stdio install commands to the repo cwd", () => {
    expect(
      buildMcpInstallCommand({
        mode: "stdio",
        isDev: true,
        origin: null,
        scopeDir: "/Users/rhyssullivan/src/executor/apps/local",
        devCliCwd: "/Users/rhyssullivan/src/executor",
      }),
    ).toBe(
      "npx add-mcp 'bun run --cwd /Users/rhyssullivan/src/executor dev:cli mcp --scope /Users/rhyssullivan/src/executor/apps/local' --name executor",
    );
  });

  it("passes browser approval through stdio install commands when explicitly selected", () => {
    expect(
      buildMcpInstallCommand({
        mode: "stdio",
        isDev: false,
        origin: null,
        elicitationMode: "browser",
      }),
    ).toBe("npx add-mcp 'executor mcp --elicitation-mode browser' --name executor");
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
        mode: "http",
        isDev: false,
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
