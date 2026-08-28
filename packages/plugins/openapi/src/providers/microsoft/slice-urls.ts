/**
 * Microsoft Graph slice URL vocabulary. Leaf module (no preset imports) shared
 * by the catalog (`presets.ts`), the runtime fetch (`slices.ts`), and the
 * adapter's URL classification.
 *
 * Slice URLs are first-class spec sources: the catalog points at them
 * directly, what the integration stores as `specUrl` is what was fetched, and
 * any narrowing within a slice travels visibly in the URL fragment
 * (`#preset=mail,calendar`). The 43MB upstream monolith URL is never silently
 * substituted — requesting it fetches it.
 */

export const MICROSOFT_GRAPH_SLICE_RELEASE_TAG = "graph-slices";

export const MICROSOFT_GRAPH_SLICE_BASE_URL = `https://github.com/UsefulSoftwareCo/executor/releases/download/${MICROSOFT_GRAPH_SLICE_RELEASE_TAG}`;

/** Asset covering the default catalog bundle (`MICROSOFT_GRAPH_DEFAULT_PRESET_IDS`). */
export const MICROSOFT_GRAPH_DEFAULT_SLICE_ASSET = "default";

export const microsoftGraphSliceUrl = (asset: string): string =>
  `${MICROSOFT_GRAPH_SLICE_BASE_URL}/${encodeURIComponent(asset)}.yaml`;

/** The asset a slice URL names, or null for any other URL. Fragment and query
 *  are ignored — callers strip the fragment into a selection separately. */
export const microsoftGraphSliceAssetFromUrl = (url: string): string | null => {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  parsed.hash = "";
  const href = parsed.toString();
  if (!href.startsWith(`${MICROSOFT_GRAPH_SLICE_BASE_URL}/`) || !href.endsWith(".yaml")) {
    return null;
  }
  const asset = decodeURIComponent(
    href.slice(`${MICROSOFT_GRAPH_SLICE_BASE_URL}/`.length, -".yaml".length),
  );
  return asset.length > 0 && !asset.includes("/") ? asset : null;
};
