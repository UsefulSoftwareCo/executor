import { describe, expect, it } from "@effect/vitest";

import { CURATED_CODEX_PLUGINS } from "./codex-plugin-presets";
import { approvalTerms } from "./invoke";
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
  // `_meta` is an open map: servers put progress tokens, internal ids, and
  // opaque state in it. Rendering all of it as "approval terms" would both
  // mislead and risk surfacing something private, so the projection is a
  // closed vocabulary.
  it("keeps the keys that say what accepting means", () => {
    expect(
      approvalTerms({
        persist: "always",
        origin: "https://example.com",
        connector_name: "Browser use",
        connector_id: "browser-use",
      }),
    ).toEqual({
      meta: {
        persist: "always",
        origin: "https://example.com",
        connector_name: "Browser use",
        connector_id: "browser-use",
      },
    });
  });

  it("drops everything else a server attached", () => {
    expect(
      approvalTerms({
        persist: "always",
        progressToken: "tok_123",
        codex_approval_kind: "mcp_tool_call",
        internalSessionId: "sess_abc",
        nested: { secret: "do not render" },
      }),
    ).toEqual({ meta: { persist: "always" } });
  });

  it("ignores non-string values and contributes nothing when no term applies", () => {
    expect(approvalTerms({ persist: { always: true }, origin: 42 })).toEqual({});
    expect(approvalTerms({ progressToken: "tok" })).toEqual({});
    expect(approvalTerms(undefined)).toEqual({});
  });
});
