import { Effect } from "effect";

import type { SpecFormatAdapter } from "../../sdk/spec-format";

import { buildMicrosoftGraphOpenApiSpec, microsoftGraphKeepPathItem } from "./graph";

const graphCatalogSelection = (
  rawUrl: string | undefined,
): { readonly specUrl?: string; readonly presetIds?: readonly string[] } => {
  if (!rawUrl || !URL.canParse(rawUrl)) return rawUrl ? { specUrl: rawUrl } : {};
  const parsed = new URL(rawUrl);
  const preset = parsed.hash.startsWith("#preset=")
    ? decodeURIComponent(parsed.hash.slice("#preset=".length))
    : "";
  parsed.hash = "";
  return {
    specUrl: parsed.toString(),
    ...(preset.length > 0 ? { presetIds: [preset] } : {}),
  };
};

export const microsoftGraphAdapter: SpecFormatAdapter = {
  id: "microsoft-graph",
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
