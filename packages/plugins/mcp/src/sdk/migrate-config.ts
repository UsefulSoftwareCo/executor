// ---------------------------------------------------------------------------
// One-off config migration — rewrite pre-canonical MCP integration `config`
// blobs into the canonical placements model. Runs once per database (boot for
// local/selfhost, out-of-band script for cloud); runtime code decodes ONLY
// the canonical shape (`parseMcpIntegrationConfig`).
//
// Stored legacy families (all observed in real databases):
//   1. singular `auth: {kind:"none"|"header"|"oauth2"}` (pre-array configs),
//      or a remote config with no auth field at all (open server)
//   2. `authenticationTemplate` entries of the retired single-placement
//      shapes: `{slug, kind:"header", headerName, prefix?}` /
//      `{slug, kind:"query", paramName, prefix?}`
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

import { parseMcpIntegrationConfig, type McpAuthMethod } from "./types";

const LegacySingleAuth = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("header"),
    headerName: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("query"),
    paramName: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("oauth2") }),
]);
const decodeLegacySingleAuth = Schema.decodeUnknownOption(LegacySingleAuth);

const LegacyHeaderMethod = Schema.Struct({
  slug: Schema.String,
  kind: Schema.Literal("header"),
  headerName: Schema.String,
  prefix: Schema.optional(Schema.String),
});
const LegacyQueryMethod = Schema.Struct({
  slug: Schema.String,
  kind: Schema.Literal("query"),
  paramName: Schema.String,
  prefix: Schema.optional(Schema.String),
});
const LegacyOAuthTemplate = Schema.Struct({
  slug: Schema.String,
  type: Schema.Literal("oauth"),
});
const decodeLegacyHeaderMethod = Schema.decodeUnknownOption(LegacyHeaderMethod);
const decodeLegacyQueryMethod = Schema.decodeUnknownOption(LegacyQueryMethod);
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
const migrateMethodEntry = (entry: unknown): McpAuthMethod | null => {
  const canonical = Option.getOrNull(CanonicalMethod(entry));
  if (canonical !== null) return entry as McpAuthMethod;

  const header = Option.getOrNull(decodeLegacyHeaderMethod(entry));
  if (header !== null) {
    return {
      slug: header.slug,
      kind: "apikey",
      placements: [
        {
          carrier: "header",
          name: header.headerName,
          ...(header.prefix !== undefined ? { prefix: header.prefix } : {}),
        },
      ],
    };
  }

  const query = Option.getOrNull(decodeLegacyQueryMethod(entry));
  if (query !== null) {
    return {
      slug: query.slug,
      kind: "apikey",
      placements: [
        {
          carrier: "query",
          name: query.paramName,
          ...(query.prefix !== undefined ? { prefix: query.prefix } : {}),
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

const slugFromSingleAuth = (auth: typeof LegacySingleAuth.Type): string => auth.kind;

const methodFromSingleAuth = (auth: typeof LegacySingleAuth.Type): McpAuthMethod => {
  if (auth.kind === "header") {
    return {
      slug: slugFromSingleAuth(auth),
      kind: "apikey",
      placements: [
        {
          carrier: "header",
          name: auth.headerName,
          ...(auth.prefix !== undefined ? { prefix: auth.prefix } : {}),
        },
      ],
    };
  }
  if (auth.kind === "query") {
    return {
      slug: slugFromSingleAuth(auth),
      kind: "apikey",
      placements: [
        {
          carrier: "query",
          name: auth.paramName,
          ...(auth.prefix !== undefined ? { prefix: auth.prefix } : {}),
        },
      ],
    };
  }
  return { slug: auth.kind, kind: auth.kind };
};

/** Rewrite a stored MCP integration config blob into the canonical shape.
 *  Returns the rewritten config, or `null` when no rewrite is needed (already
 *  canonical, a stdio config, or not this plugin's shape at all). Throws
 *  nothing: an unmigratable blob also returns `null` and stays untouched.
 *  Idempotent — feeding the output back returns `null`. */
export const migrateMcpAuthConfig = (config: unknown): unknown | null => {
  if (typeof config !== "object" || config === null) return null;
  if (!("transport" in config) || config.transport !== "remote") return null;

  if (!("authenticationTemplate" in config)) {
    // Family 1: singular `auth`, or an open server with no auth field.
    const auth =
      "auth" in config
        ? Option.getOrNull(decodeLegacySingleAuth(config.auth))
        : { kind: "none" as const };
    if (auth === null) return null;
    const { auth: _auth, ...rest } = config as { auth?: unknown };
    const migrated = { ...rest, authenticationTemplate: [methodFromSingleAuth(auth)] };
    return parseMcpIntegrationConfig(migrated) !== null ? migrated : null;
  }

  const entries = (config as { authenticationTemplate: unknown }).authenticationTemplate;
  if (!Array.isArray(entries)) return null;

  const migrated = entries.map(migrateMethodEntry);
  if (migrated.some((entry) => entry === null)) return null;
  const changed = migrated.some((entry, index) => entry !== entries[index]);
  if (!changed) return null;

  const next = { ...config, authenticationTemplate: migrated };
  return parseMcpIntegrationConfig(next) !== null ? next : null;
};
