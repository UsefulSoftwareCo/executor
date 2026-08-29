import { describe, expect, it } from "@effect/vitest";

import { CURATED_CODEX_PLUGINS } from "./codex-plugin-presets";
import { APPROVAL_TERM_KEYS } from "./invoke";
import { mcpPresets } from "./presets";

// ---------------------------------------------------------------------------
// The connect dialog's search runs over the STATIC preset catalog (name +
// summary + family), so the curated Codex plugins must exist there as stdio
// presets — with an empty command, because the real spawn recipe is
// machine-specific and comes from the server-side scanner. These pins keep
// "imessage" / "computer use" searches finding the cards.
// ---------------------------------------------------------------------------

const presetById = (id: string) => mcpPresets.find((preset) => preset.id === id);

describe("codex catalog presets", () => {
  it("lists every curated codex plugin as a command-less stdio preset", () => {
    for (const plugin of CURATED_CODEX_PLUGINS) {
      expect(presetById(plugin.id), plugin.id).toMatchObject({
        name: plugin.name,
        summary: plugin.summary,
        family: "codex",
        transport: "stdio",
        command: "",
      });
    }
  });

  it("matches the words people actually search", () => {
    const corpus = (id: string) => {
      const preset = presetById(id)!;
      return `${preset.name} ${preset.summary}`.toLowerCase();
    };
    expect(corpus("codex-messages")).toContain("imessage");
    expect(corpus("codex-messages")).toContain("texts");
    expect(corpus("codex-messages")).toContain("apple");
    expect(corpus("codex-computer-use")).toContain("computer use");
    expect(corpus("codex-computer-history")).toContain("activity");
  });
});

describe("approval terms", () => {
  // The projection lives at the MCP boundary (`invoke.ts`), but the vocabulary
  // it recognises is the contract these plugins speak, so pin it here.
  it("names only the keys that describe what accepting means", () => {
    // Codex's browser approval says the grant persists, and for which origin.
    // Everything else a server puts in `_meta` — progress tokens, internal
    // ids, opaque state — is not a term the user is agreeing to, and must not
    // be rendered as one.
    expect(APPROVAL_TERM_KEYS).toEqual(["persist", "origin", "connector_name", "connector_id"]);
  });
});
