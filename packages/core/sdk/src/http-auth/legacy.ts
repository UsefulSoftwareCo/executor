// ---------------------------------------------------------------------------
// FROZEN legacy shapes — input vocabulary for the one-off config migrations.
//
// Before the canonical placements model, the OpenAPI plugin (and the v1→v2
// migration, which wrote this shape into MCP and GraphQL configs too) stored
// apiKey methods as header/query records of TEMPLATE VALUES: a string literal
// or a part-array interleaving literals with `{ type: "variable", name }`
// references.
//
// Runtime code must not import this module — it exists so every plugin's
// `migrate-config` rewrites stored blobs the same way, and the rules below are
// the contract: variable names are preserved VERBATIM (they key the
// connections' stored `item_ids`), the placement prefix is the literal run
// before the first variable, a literal-only value becomes a `literal`
// placement, and anything after the first variable is dropped (matching what
// the descriptor projection has always shown).
// ---------------------------------------------------------------------------

import { Schema } from "effect";

import { TOKEN_VARIABLE, type ApiKeyAuthMethod, type AuthPlacement } from "./auth-method";

const LegacyVariablePart = Schema.Struct({
  type: Schema.Literal("variable"),
  name: Schema.String,
});

export const LegacyTemplateValue = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Union([Schema.String, LegacyVariablePart])),
]);
export type LegacyTemplateValue = typeof LegacyTemplateValue.Type;

/** The pre-canonical apiKey template shape (OpenAPI native + what the v1→v2
 *  migration wrote into MCP/GraphQL configs). */
export const LegacyApiKeyTemplate = Schema.Struct({
  slug: Schema.String,
  type: Schema.Literal("apiKey"),
  headers: Schema.optional(Schema.Record(Schema.String, LegacyTemplateValue)),
  queryParams: Schema.optional(Schema.Record(Schema.String, LegacyTemplateValue)),
});
export type LegacyApiKeyTemplate = typeof LegacyApiKeyTemplate.Type;

export const decodeLegacyApiKeyTemplate = Schema.decodeUnknownOption(LegacyApiKeyTemplate);

const placementFromTemplateValue = (
  carrier: "header" | "query",
  name: string,
  value: LegacyTemplateValue,
): AuthPlacement => {
  if (typeof value === "string") return { carrier, name, literal: value };
  const literals: string[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      literals.push(part);
      continue;
    }
    const prefix = literals.join("");
    return {
      carrier,
      name,
      ...(prefix ? { prefix } : {}),
      ...(part.name !== TOKEN_VARIABLE ? { variable: part.name } : {}),
    };
  }
  return { carrier, name, literal: literals.join("") };
};

/** Rewrite a legacy apiKey template into the canonical placements method.
 *  Slug and variable names are preserved verbatim. */
export const apiKeyMethodFromLegacyTemplate = (
  template: LegacyApiKeyTemplate,
): ApiKeyAuthMethod => {
  const placements: AuthPlacement[] = [];
  for (const [name, value] of Object.entries(template.headers ?? {})) {
    placements.push(placementFromTemplateValue("header", name, value));
  }
  for (const [name, value] of Object.entries(template.queryParams ?? {})) {
    placements.push(placementFromTemplateValue("query", name, value));
  }
  return { slug: template.slug, kind: "apikey", placements };
};
