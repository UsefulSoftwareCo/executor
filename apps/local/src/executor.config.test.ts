import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";

import executorConfig from "../executor.config";

// ---------------------------------------------------------------------------
// Pins the shipped local config's secrets ordering (keychain before file —
// the first writable provider becomes the default for minted OAuth tokens)
// and the stdio-MCP default (off).
// ---------------------------------------------------------------------------

describe("executor.config secrets ordering", () => {
  it("registers keychain before fileSecrets (keychain wins as default when reachable)", () => {
    const plugins = executorConfig.plugins();
    const names = plugins.map((p) => p.id);
    const keychainIdx = names.indexOf("keychain");
    const fileIdx = names.indexOf("fileSecrets");
    expect(keychainIdx, "keychain must be present").toBeGreaterThan(-1);
    expect(fileIdx, "fileSecrets must be present").toBeGreaterThan(-1);
    expect(keychainIdx).toBeLessThan(fileIdx);
  });

  it("keeps the full plugin set intact (no plugin dropped by the reorder)", () => {
    const plugins = executorConfig.plugins();
    const ids = plugins.map((p) => p.id).sort();
    expect(ids).toEqual(
      [
        "openapi",
        "mcp",
        "graphql",
        "toolkits",
        "keychain",
        "fileSecrets",
        "onepassword",
        "desktop-settings",
      ].sort(),
    );
  });

  it("does not enable stdio MCP in the shipped config (config-side contract)", () => {
    // The plugin's runtime default is `?? false` (plugin.ts:751); the
    // config-side contract is that the shipped local app does not pass
    // `dangerouslyAllowStdioMCP: true`. Assert the source literal so a
    // future re-enable trips this test.
    const source = readFileSync(join(import.meta.dirname, "..", "executor.config.ts"), "utf8");
    expect(source).not.toContain("dangerouslyAllowStdioMCP: true");
  });
});
