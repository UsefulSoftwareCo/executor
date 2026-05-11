import { describe, expect, it } from "@effect/vitest";

import { buildMcpInstallCommand, shellQuoteWord } from "./mcp-install-card";

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
});
