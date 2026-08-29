import { describe, expect, it } from "@effect/vitest";

import { CURATED_CODEX_PLUGINS } from "./codex-plugin-presets";
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
