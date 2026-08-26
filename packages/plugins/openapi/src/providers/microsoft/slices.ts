import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { OpenApiParseError } from "../../sdk/errors";

import { MICROSOFT_GRAPH_DEFAULT_PRESET_IDS, microsoftGraphPresetForId } from "./presets";

/**
 * Runtime access to precomputed Microsoft Graph slices.
 *
 * The 43MB Graph monolith cannot be processed in a 128MB Workers isolate — in
 * production its fetch alone completed once in the 30 days before 2026-08-26;
 * every other preview/add died mid-download with an empty 503. Slices are
 * built offline (`slice-build.ts`, refreshed by the graph-slices workflow),
 * published as release assets, and fetched here per selection: the isolate
 * only ever holds the sub-megabyte filtered document for the selection.
 */

export const MICROSOFT_GRAPH_SLICE_RELEASE_TAG = "graph-slices";

export const MICROSOFT_GRAPH_SLICE_BASE_URL = `https://github.com/UsefulSoftwareCo/executor/releases/download/${MICROSOFT_GRAPH_SLICE_RELEASE_TAG}`;

/** Asset name for the default catalog bundle (`MICROSOFT_GRAPH_DEFAULT_PRESET_IDS`). */
export const MICROSOFT_GRAPH_DEFAULT_SLICE_ASSET = "default";

/**
 * The published asset covering a selection, or null when the selection needs
 * the monolith. A slice may be a superset of the selection: the runtime always
 * applies the selection's `keepPathItem` filter to whatever source it reads, so
 * any combination within the default bundle can be served from the default
 * slice and narrowed in-band. The monolith remains necessary for full-graph
 * coverage, custom scopes (scope matching walks operations outside any
 * preset's paths), and combinations reaching outside the default bundle
 * (precomputing every combination is combinatorial).
 */
export const microsoftGraphSliceAssetForSelection = (selection: {
  readonly coversFullGraph: boolean;
  readonly presetIds: readonly string[];
  readonly customScopes: readonly string[];
}): string | null => {
  if (selection.coversFullGraph) return null;
  if (selection.customScopes.length > 0) return null;
  if (selection.presetIds.length === 0) return null;
  if (selection.presetIds.some((presetId) => !microsoftGraphPresetForId(presetId))) return null;
  if (selection.presetIds.length === 1) return selection.presetIds[0]!;
  const defaultIds = new Set(MICROSOFT_GRAPH_DEFAULT_PRESET_IDS);
  if (selection.presetIds.every((presetId) => defaultIds.has(presetId))) {
    return MICROSOFT_GRAPH_DEFAULT_SLICE_ASSET;
  }
  return null;
};

export const microsoftGraphSliceUrl = (asset: string): string =>
  `${MICROSOFT_GRAPH_SLICE_BASE_URL}/${encodeURIComponent(asset)}.yaml`;

export const fetchMicrosoftGraphSlice = Effect.fn("Microsoft.fetchGraphSlice")(function* (
  asset: string,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.get(microsoftGraphSliceUrl(asset)).pipe(
        HttpClientRequest.setHeader("Accept", "application/yaml, text/yaml, */*"),
      ),
    )
    .pipe(
      Effect.mapError(
        () =>
          new OpenApiParseError({
            message: `Failed to fetch Microsoft Graph slice: ${asset}`,
          }),
      ),
    );
  if (response.status < 200 || response.status >= 300) {
    return yield* new OpenApiParseError({
      message: `Failed to fetch Microsoft Graph slice ${asset}: HTTP ${response.status}`,
    });
  }
  return yield* response.text.pipe(
    Effect.mapError(
      () =>
        new OpenApiParseError({
          message: `Failed to read Microsoft Graph slice body: ${asset}`,
        }),
    ),
  );
});
