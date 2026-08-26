import { describe, expect, it } from "@effect/vitest";

import { MICROSOFT_GRAPH_DEFAULT_PRESET_IDS, MICROSOFT_GRAPH_OPENAPI_URL } from "./presets";
import {
  MICROSOFT_GRAPH_DEFAULT_SLICE_ASSET,
  microsoftGraphPresetIdsForSliceAsset,
  microsoftGraphSliceAssetFromUrl,
  microsoftGraphSliceUrl,
} from "./slices";

describe("microsoftGraphSliceAssetFromUrl", () => {
  it("round-trips slice URLs and ignores fragments", () => {
    expect(microsoftGraphSliceAssetFromUrl(microsoftGraphSliceUrl("mail"))).toBe("mail");
    expect(
      microsoftGraphSliceAssetFromUrl(`${microsoftGraphSliceUrl("default")}#preset=mail,calendar`),
    ).toBe(MICROSOFT_GRAPH_DEFAULT_SLICE_ASSET);
  });

  it("rejects non-slice URLs", () => {
    expect(microsoftGraphSliceAssetFromUrl(MICROSOFT_GRAPH_OPENAPI_URL)).toBeNull();
    expect(microsoftGraphSliceAssetFromUrl("https://example.com/mail.yaml")).toBeNull();
    expect(microsoftGraphSliceAssetFromUrl("not a url")).toBeNull();
  });
});

describe("microsoftGraphPresetIdsForSliceAsset", () => {
  it("maps a preset asset to its single preset", () => {
    expect(microsoftGraphPresetIdsForSliceAsset("mail")).toEqual(["mail"]);
  });

  it("maps the default asset to the default bundle", () => {
    expect(microsoftGraphPresetIdsForSliceAsset(MICROSOFT_GRAPH_DEFAULT_SLICE_ASSET)).toEqual(
      MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
    );
  });

  it("returns null for unknown assets", () => {
    expect(microsoftGraphPresetIdsForSliceAsset("not-a-preset")).toBeNull();
  });
});
