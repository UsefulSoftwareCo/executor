import { describe, expect, it } from "@effect/vitest";

import { MICROSOFT_GRAPH_ALL_PRESET_IDS, MICROSOFT_GRAPH_DEFAULT_PRESET_IDS } from "./presets";
import {
  MICROSOFT_GRAPH_DEFAULT_SLICE_ASSET,
  microsoftGraphSliceAssetForSelection,
} from "./slices";

describe("microsoftGraphSliceAssetForSelection", () => {
  it("maps a single catalog preset to its asset", () => {
    expect(
      microsoftGraphSliceAssetForSelection({
        coversFullGraph: false,
        presetIds: ["mail"],
        customScopes: [],
      }),
    ).toBe("mail");
  });

  it("maps the default bundle in any order to the default asset", () => {
    expect(
      microsoftGraphSliceAssetForSelection({
        coversFullGraph: false,
        presetIds: [...MICROSOFT_GRAPH_DEFAULT_PRESET_IDS].reverse(),
        customScopes: [],
      }),
    ).toBe(MICROSOFT_GRAPH_DEFAULT_SLICE_ASSET);
  });

  it("serves combinations within the default bundle from the default slice", () => {
    expect(
      microsoftGraphSliceAssetForSelection({
        coversFullGraph: false,
        presetIds: ["mail", "calendar"],
        customScopes: [],
      }),
    ).toBe(MICROSOFT_GRAPH_DEFAULT_SLICE_ASSET);
  });

  it("needs the monolith for full-graph, custom scopes, unknown presets, and combinations outside the default bundle", () => {
    expect(
      microsoftGraphSliceAssetForSelection({
        coversFullGraph: true,
        presetIds: [...MICROSOFT_GRAPH_ALL_PRESET_IDS],
        customScopes: [],
      }),
    ).toBeNull();
    expect(
      microsoftGraphSliceAssetForSelection({
        coversFullGraph: false,
        presetIds: ["mail"],
        customScopes: ["Chat.Read"],
      }),
    ).toBeNull();
    expect(
      microsoftGraphSliceAssetForSelection({
        coversFullGraph: false,
        presetIds: ["not-a-preset"],
        customScopes: [],
      }),
    ).toBeNull();
    expect(
      microsoftGraphSliceAssetForSelection({
        coversFullGraph: false,
        presetIds: ["mail", "users"],
        customScopes: [],
      }),
    ).toBeNull();
  });
});
