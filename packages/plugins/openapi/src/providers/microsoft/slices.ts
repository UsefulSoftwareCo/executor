import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { OpenApiParseError } from "../../sdk/errors";

import { MICROSOFT_GRAPH_DEFAULT_PRESET_IDS, microsoftGraphPresetForId } from "./presets";
import { MICROSOFT_GRAPH_DEFAULT_SLICE_ASSET } from "./slice-urls";

export {
  MICROSOFT_GRAPH_DEFAULT_SLICE_ASSET,
  MICROSOFT_GRAPH_SLICE_BASE_URL,
  MICROSOFT_GRAPH_SLICE_RELEASE_TAG,
  microsoftGraphSliceAssetFromUrl,
  microsoftGraphSliceUrl,
} from "./slice-urls";

/**
 * Runtime access to precomputed Microsoft Graph slices.
 *
 * The 43MB Graph monolith cannot be processed in a 128MB Workers isolate — in
 * production its fetch alone completed once in the 30 days before 2026-08-26.
 * Slices are built offline (`slice-build.ts`, refreshed by the graph-slices
 * workflow) and published as release assets that the catalog references as
 * ordinary spec URLs; the isolate only ever holds the filtered document it was
 * actually asked to fetch.
 */

/** The preset selection a slice asset carries when the URL has no narrowing
 *  fragment, or null for an unknown asset. */
export const microsoftGraphPresetIdsForSliceAsset = (asset: string): readonly string[] | null => {
  if (asset === MICROSOFT_GRAPH_DEFAULT_SLICE_ASSET) return MICROSOFT_GRAPH_DEFAULT_PRESET_IDS;
  return microsoftGraphPresetForId(asset) ? [asset] : null;
};

export const fetchMicrosoftGraphSlice = Effect.fn("Microsoft.fetchGraphSlice")(function* (
  sliceUrl: string,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.get(sliceUrl).pipe(
        HttpClientRequest.setHeader("Accept", "application/yaml, text/yaml, */*"),
      ),
    )
    .pipe(
      Effect.mapError(
        () =>
          new OpenApiParseError({
            message: "Failed to fetch the Microsoft Graph slice document",
          }),
      ),
    );
  if (response.status < 200 || response.status >= 300) {
    return yield* new OpenApiParseError({
      message: `Failed to fetch the Microsoft Graph slice document: HTTP ${response.status}`,
    });
  }
  return yield* response.text.pipe(
    Effect.mapError(
      () =>
        new OpenApiParseError({
          message: "Failed to read the Microsoft Graph slice document body",
        }),
    ),
  );
});
