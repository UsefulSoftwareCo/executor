import { Effect } from "effect";

import type { SpecFormatAdapter } from "../../sdk/spec-format";

import { buildMicrosoftGraphOpenApiSpec, microsoftGraphKeepPathItem } from "./graph";
import { MICROSOFT_GRAPH_OPENAPI_URL } from "./presets";
import { microsoftGraphPresetIdsForSliceAsset, microsoftGraphSliceAssetFromUrl } from "./slices";

const fragmentPresetIds = (hash: string): readonly string[] =>
  hash.startsWith("#preset=")
    ? decodeURIComponent(hash.slice("#preset=".length))
        .split(",")
        .map((presetId) => presetId.trim())
        .filter((presetId) => presetId.length > 0)
    : [];

/**
 * Selection from a catalog URL. A slice URL is the byte source itself: its
 * asset carries the selection, and a fragment may narrow within the asset.
 * Any other URL (the upstream monolith, an emulator override) is fetched as
 * given, with the fragment as the selection filter.
 */
const graphCatalogSelection = (
  rawUrl: string | undefined,
): { readonly specUrl?: string; readonly presetIds?: readonly string[] } => {
  if (!rawUrl || !URL.canParse(rawUrl)) return rawUrl ? { specUrl: rawUrl } : {};
  const parsed = new URL(rawUrl);
  const fromFragment = fragmentPresetIds(parsed.hash);
  parsed.hash = "";
  const specUrl = parsed.toString();
  const sliceAsset = microsoftGraphSliceAssetFromUrl(specUrl);
  const presetIds =
    fromFragment.length > 0
      ? fromFragment
      : sliceAsset !== null
        ? (microsoftGraphPresetIdsForSliceAsset(sliceAsset) ?? [])
        : [];
  return {
    specUrl,
    ...(presetIds.length > 0 ? { presetIds } : {}),
  };
};

/** Recognizes the Graph sources this adapter exists to handle: Microsoft's
 *  published monolith and executor's slice assets, with or without a
 *  `#preset=` selector. Without this, pasting one of those URLs by hand falls
 *  to the plain OpenAPI path, which then chokes on the 43 MB monolith — the
 *  adapter only ever engaged when a preset supplied `specFormat`. */
const detectsGraphUrl = (url: string): boolean => {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  parsed.hash = "";
  const bare = parsed.toString();
  return (
    bare === MICROSOFT_GRAPH_OPENAPI_URL ||
    microsoftGraphSliceAssetFromUrl(bare) !== null ||
    /^https:\/\/raw\.githubusercontent\.com\/microsoftgraph\/msgraph-metadata\/.*\/openapi\.ya?ml$/.test(
      bare,
    )
  );
};

export const microsoftGraphAdapter: SpecFormatAdapter = {
  id: "microsoft-graph",
  detectsUrl: detectsGraphUrl,
  fetch: (input) =>
    buildMicrosoftGraphOpenApiSpec(
      graphCatalogSelection(input.urls[0]),
      input.httpClientLayer,
    ).pipe(
      Effect.map((graphSpec) => ({
        specText: graphSpec.specText,
        specUrl: graphSpec.specUrl,
        baseUrl: graphSpec.baseUrl,
        authenticationTemplate: graphSpec.authenticationTemplate,
        // Stream the full Graph source straight to persisted bindings. This is
        // the measured Workers contention/OOM path from the Microsoft plugin:
        // structural split stays serial and avoids materializing the 37MB tree.
        keepPathItem: microsoftGraphKeepPathItem(graphSpec),
        config: {
          microsoftGraphPresetIds: graphSpec.presetIds,
          microsoftGraphCustomScopes: graphSpec.customScopes,
          microsoftGraphScopes: graphSpec.scopes,
          microsoftGraphExactPaths: graphSpec.exactPaths,
          microsoftGraphPathPrefixes: graphSpec.pathPrefixes,
          microsoftGraphTagPrefixes: graphSpec.tagPrefixes,
          microsoftGraphCoversFullGraph: graphSpec.coversFullGraph,
          microsoftGraphAuthorizationUrl: graphSpec.authorizationUrl,
          microsoftGraphTokenUrl: graphSpec.tokenUrl,
          microsoftGraphClientCredentialsTokenUrl: graphSpec.clientCredentialsTokenUrl,
        },
      })),
    ),
};
