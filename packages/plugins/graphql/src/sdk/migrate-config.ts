// ---------------------------------------------------------------------------
// One-off config migration — rewrite pre-canonical GraphQL integration
// `config` blobs into the canonical placements model. Runs once per database
// (boot for local/selfhost, out-of-band script for cloud); runtime code
// decodes ONLY the canonical shape (`decodeGraphqlIntegrationConfig*`).
//
// Stored legacy families (all observed in real databases):
//   1. the v1→v2 migration's singular `auth: {kind:"none"|"oauth2"}` (the
//      graphql config had no `authenticationTemplate` unless v1 carried
//      credential placements), or a config with no auth fields at all
//   2. `authenticationTemplate` entries of the retired native shape:
//      `{kind:"apiKey", slug, in:"header"|"query", name, prefix?}`
//   3. openapi-shaped entries the v1→v2 migration wrote:
//      `{slug, type:"apiKey", headers/queryParams: <template values>}` and
//      `{slug, type:"oauth", …}`
//
// Invariants: slugs are preserved verbatim (`connection.template` binds by
// them) and so are variable names (they key the connections' stored
// `item_ids`).
// ---------------------------------------------------------------------------

import { Option, Schema } from "effect";
import {
  apiKeyMethodFromLegacyTemplate,
  decodeLegacyApiKeyTemplate,
} from "@executor-js/sdk/http-auth";

import { decodeGraphqlIntegrationConfigOption, type GraphqlAuthMethod } from "./types";

const LegacySingleAuth = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("oauth2") }),
]);
const decodeLegacySingleAuth = Schema.decodeUnknownOption(LegacySingleAuth);

const LegacyNativeApiKey = Schema.Struct({
  slug: Schema.String,
  kind: Schema.Literal("apiKey"),
  in: Schema.Literals(["header", "query"]),
  name: Schema.String,
  prefix: Schema.optional(Schema.String),
});
const LegacyOAuthTemplate = Schema.Struct({
  slug: Schema.String,
  type: Schema.Literal("oauth"),
});
const decodeLegacyNativeApiKey = Schema.decodeUnknownOption(LegacyNativeApiKey);
const decodeLegacyOAuthTemplate = Schema.decodeUnknownOption(LegacyOAuthTemplate);

const CanonicalMethod = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ slug: Schema.String, kind: Schema.Literals(["none", "oauth2"]) }),
    Schema.Struct({
      slug: Schema.String,
      kind: Schema.Literal("apikey"),
      label: Schema.optional(Schema.String),
      placements: Schema.Array(Schema.Unknown),
    }),
  ]),
);

/** Rewrite one stored method entry to canonical, or null when undecodable. */
const migrateMethodEntry = (entry: unknown): GraphqlAuthMethod | null => {
  const canonical = Option.getOrNull(CanonicalMethod(entry));
  if (canonical !== null) return entry as GraphqlAuthMethod;

  const native = Option.getOrNull(decodeLegacyNativeApiKey(entry));
  if (native !== null) {
    return {
      slug: native.slug,
      kind: "apikey",
      placements: [
        {
          carrier: native.in,
          name: native.name,
          ...(native.prefix !== undefined ? { prefix: native.prefix } : {}),
        },
      ],
    };
  }

  const legacyApiKey = Option.getOrNull(decodeLegacyApiKeyTemplate(entry));
  if (legacyApiKey !== null) return apiKeyMethodFromLegacyTemplate(legacyApiKey);

  const legacyOAuth = Option.getOrNull(decodeLegacyOAuthTemplate(entry));
  if (legacyOAuth !== null) return { slug: legacyOAuth.slug, kind: "oauth2" };

  return null;
};

const parseConfig = (config: unknown): unknown | null =>
  Option.isSome(decodeGraphqlIntegrationConfigOption(config)) ? config : null;

/** Rewrite a stored GraphQL integration config blob into the canonical shape.
 *  Returns the rewritten config, or `null` when no rewrite is needed (already
 *  canonical, or not this plugin's shape at all). Throws nothing: an
 *  unmigratable blob also returns `null` and stays untouched. Idempotent —
 *  feeding the output back returns `null`. */
export const migrateGraphqlAuthConfig = (config: unknown): unknown | null => {
  if (typeof config !== "object" || config === null) return null;
  // A GraphQL config is keyed by its endpoint; `transport` marks MCP blobs.
  if (!("endpoint" in config) || typeof config.endpoint !== "string") return null;
  if ("transport" in config) return null;

  const legacyAuth =
    "auth" in config
      ? Option.getOrNull(decodeLegacySingleAuth((config as { auth: unknown }).auth))
      : null;

  if (!("authenticationTemplate" in config)) {
    // Family 1: singular `auth`, or an open endpoint with no auth field.
    if ("auth" in config && legacyAuth === null) return null;
    const kind = legacyAuth?.kind ?? "none";
    const { auth: _auth, ...rest } = config as { auth?: unknown };
    const migrated = { ...rest, authenticationTemplate: [{ slug: kind, kind }] };
    return parseConfig(migrated);
  }

  const entries = (config as { authenticationTemplate: unknown }).authenticationTemplate;
  if (!Array.isArray(entries)) return null;

  const migrated = entries.map(migrateMethodEntry);
  if (migrated.some((entry) => entry === null)) return null;
  const methods = migrated as GraphqlAuthMethod[];

  // The v1→v2 migration wrote BOTH `auth: {kind:"oauth2"}` and an apiKey
  // `authenticationTemplate` when a source had credential placements and
  // oauth; fold the singular auth into the declared set (slug = kind, the
  // slug the connection migration bound oauth connections to).
  if (
    legacyAuth?.kind === "oauth2" &&
    !methods.some((method: GraphqlAuthMethod) => method.kind === "oauth2")
  ) {
    methods.push({ slug: "oauth2", kind: "oauth2" });
  }

  const entriesChanged =
    methods.length !== entries.length ||
    methods.some((entry: GraphqlAuthMethod, index: number) => entry !== entries[index]);
  if (!entriesChanged && legacyAuth === null) return null;

  const { auth: _auth, ...withoutAuth } = config as { auth?: unknown };
  const next = {
    ...(legacyAuth !== null ? withoutAuth : config),
    authenticationTemplate: methods,
  };
  return parseConfig(next);
};
