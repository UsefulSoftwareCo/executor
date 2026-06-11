// ---------------------------------------------------------------------------
// One-off config migration — rewrite pre-canonical OpenAPI integration
// `config` blobs into the canonical placements model. Runs once per database
// (boot for local/selfhost, out-of-band script for cloud); runtime code
// decodes ONLY the canonical shape (`decodeOpenApiIntegrationConfig`).
//
// The retired shape is the `variable()`-templated apiKey:
//   { slug, type: "apiKey", headers/queryParams: Record<name,
//     string | (string | {type:"variable", name})[]> }
// Each entry becomes one placement: prefix = literals before the first
// variable, the variable name preserved VERBATIM (it keys the connections'
// stored `item_ids`; the canonical `token` is stored as absent), a
// literal-only value becomes a `literal` placement. OAuth templates
// re-key from the retired `type: "oauth"` spelling to `kind: "oauth2"`.
// ---------------------------------------------------------------------------

import { Option } from "effect";
import {
  apiKeyMethodFromLegacyTemplate,
  decodeLegacyApiKeyTemplate,
} from "@executor-js/sdk/http-auth";

import { decodeOpenApiIntegrationConfig } from "./config";

const isCanonicalEntry = (entry: unknown): boolean =>
  typeof entry === "object" &&
  entry !== null &&
  "kind" in entry &&
  ((entry as { kind: unknown }).kind === "apikey" ||
    (entry as { kind: unknown }).kind === "oauth2");

/** The retired oauth spelling: `type: "oauth"` instead of `kind: "oauth2"`. */
const isLegacyOAuthEntry = (
  entry: unknown,
): entry is { readonly type: "oauth" } & Record<string, unknown> =>
  typeof entry === "object" &&
  entry !== null &&
  "type" in entry &&
  (entry as { type: unknown }).type === "oauth";

const migrateEntry = (entry: unknown): unknown | null => {
  if (isCanonicalEntry(entry)) return entry;
  if (isLegacyOAuthEntry(entry)) {
    const { type: _type, ...rest } = entry;
    return { ...rest, kind: "oauth2" };
  }
  const legacy = Option.getOrNull(decodeLegacyApiKeyTemplate(entry));
  if (legacy !== null) return apiKeyMethodFromLegacyTemplate(legacy);
  return null;
};

/** Rewrite a stored OpenAPI integration config blob into the canonical shape.
 *  Returns the rewritten config, or `null` when no rewrite is needed (already
 *  canonical, no auth templates, or not this plugin's shape). Idempotent. */
export const migrateOpenApiAuthConfig = (config: unknown): unknown | null => {
  if (typeof config !== "object" || config === null) return null;
  if (!("spec" in config) && !("specHash" in config)) return null;
  if (!("authenticationTemplate" in config)) return null;

  const entries = (config as { authenticationTemplate: unknown }).authenticationTemplate;
  if (!Array.isArray(entries)) return null;

  const migrated = entries.map(migrateEntry);
  if (migrated.some((entry) => entry === null)) return null;
  const changed = migrated.some((entry, index) => entry !== entries[index]);
  if (!changed) return null;

  const next = { ...config, authenticationTemplate: migrated };
  return decodeOpenApiIntegrationConfig(next) !== null ? next : null;
};
