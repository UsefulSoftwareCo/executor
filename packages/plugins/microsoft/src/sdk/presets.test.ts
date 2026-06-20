import { describe, expect, it } from "@effect/vitest";

import {
  MICROSOFT_GRAPH_BASE_SCOPES,
  MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  microsoftGraphExactPathsForPresetIds,
  microsoftGraphPathPrefixesForPresetIds,
  microsoftGraphScopePresets,
  microsoftGraphScopesForPresetIds,
} from "./presets";

describe("Microsoft Graph scope presets", () => {
  it("keeps default workload ids backed by real presets", () => {
    const ids = new Set(microsoftGraphScopePresets.map((preset) => preset.id));
    expect(MICROSOFT_GRAPH_DEFAULT_PRESET_IDS.every((id) => ids.has(id))).toBe(true);
  });

  it("unions selected preset scopes with base and custom scopes", () => {
    expect(microsoftGraphScopesForPresetIds(["profile", "mail"], ["Sites.Read.All"])).toEqual([
      ...MICROSOFT_GRAPH_BASE_SCOPES,
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "Sites.Read.All",
    ]);
  });

  it("returns path filters for the selected workloads", () => {
    expect(microsoftGraphExactPathsForPresetIds(["profile"])).toContain("/me");
    expect(microsoftGraphPathPrefixesForPresetIds(["mail"])).toContain("/me/messages");
  });

  it("declares product icons for each workload", () => {
    for (const preset of microsoftGraphScopePresets) {
      expect(preset.icon).toMatch(/^https:\/\/svgl\.app\/library\/.+\.svg$/);
    }
  });
});
