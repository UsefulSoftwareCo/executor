import { describe, expect, it } from "@effect/vitest";

import { buildMcpHttpEndpoint, buildMcpInstallCommand, shellQuoteWord } from "./mcp-install-card";

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
});
