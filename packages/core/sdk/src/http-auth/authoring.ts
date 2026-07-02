// ---------------------------------------------------------------------------
// Request-shaped authoring — the second accepted INPUT dialect for apikey
// methods, alongside canonical placements. It reads like the HTTP request it
// produces:
//
//   {
//     slug: "bearer",
//     type: "apiKey",
//     headers: { Authorization: ["Bearer ", variable("token")] },
//     queryParams: { team_id: [variable("team_id")] },
//   }
//
// A record value is either a parts-array (`prefix literals… + one variable,
// last`) rendering a credential input, or a plain string rendering a static
// literal. Normalized to canonical placements at the boundary — STORED
// configs carry only the canonical shape.
//
// Authoring is strict where the migration is tolerant: a parts-array with a
// variable anywhere but last, or with more than one variable, is rejected at
// decode time with a pointed message (the renderer and UI honor exactly
// prefix+variable, so accepting more would silently lose information —
// `migrate-config` only flattens that way for pre-existing stored data).
// ---------------------------------------------------------------------------

import { Schema } from "effect";

import { TOKEN_VARIABLE, type ApiKeyAuthMethod, type AuthPlacement } from "./auth-method";

export interface AuthTemplateVariable {
  readonly type: "variable";
  readonly name: string;
}

/** Mark where a credential input renders inside a template value:
 *  `["Bearer ", variable("token")]`. */
export const variable = (name: string): AuthTemplateVariable => ({ type: "variable", name });

const VariablePart = Schema.Struct({
  type: Schema.Literal("variable"),
  name: Schema.String,
});

const isVariablePart = (part: string | AuthTemplateVariable): part is AuthTemplateVariable =>
  typeof part !== "string";

/** `string` (a static literal) or `prefix literals… + one variable, last`. */
export const AuthTemplateValue = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Union([Schema.String, VariablePart])).check(
    Schema.makeFilter((parts) => {
      const variableIndexes = parts.flatMap((part, index) => (isVariablePart(part) ? [index] : []));
      if (
        variableIndexes.length > 1 ||
        (variableIndexes.length === 1 && variableIndexes[0] !== parts.length - 1)
      ) {
        return "a template value renders at most ONE variable, as the FINAL part — split extra variables/suffixes into separate header or query entries";
      }
      return undefined;
    }),
  ),
]);
export type AuthTemplateValue = typeof AuthTemplateValue.Type;

/** The request-shaped apikey authoring dialect. `slug` optional (backfilled
 *  like every other input); `label` optional. */
export const ApiKeyAuthTemplate = Schema.Struct({
  slug: Schema.optional(Schema.String),
  type: Schema.Literal("apiKey"),
  label: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, AuthTemplateValue)),
  queryParams: Schema.optional(Schema.Record(Schema.String, AuthTemplateValue)),
});
export type ApiKeyAuthTemplate = typeof ApiKeyAuthTemplate.Type;

const placementFromValue = (
  carrier: "header" | "query",
  name: string,
  value: AuthTemplateValue,
): AuthPlacement => {
  if (typeof value === "string") return { carrier, name, literal: value };
  const variablePart = value.find(isVariablePart);
  if (variablePart === undefined) {
    return { carrier, name, literal: value.filter((p) => typeof p === "string").join("") };
  }
  const prefix = value.filter((part): part is string => typeof part === "string").join("");
  return {
    carrier,
    name,
    ...(prefix ? { prefix } : {}),
    ...(variablePart.name !== TOKEN_VARIABLE ? { variable: variablePart.name } : {}),
  };
};

/** Normalize the request-shaped dialect into the canonical apikey method
 *  (sans slug backfill — the caller's normalize pass owns slugs). */
export const apiKeyMethodFromAuthTemplate = (
  template: ApiKeyAuthTemplate,
): Omit<ApiKeyAuthMethod, "slug"> & { readonly slug?: string } => {
  const placements: AuthPlacement[] = [];
  for (const [name, value] of Object.entries(template.headers ?? {})) {
    placements.push(placementFromValue("header", name, value));
  }
  for (const [name, value] of Object.entries(template.queryParams ?? {})) {
    placements.push(placementFromValue("query", name, value));
  }
  return {
    ...(template.slug !== undefined ? { slug: template.slug } : {}),
    kind: "apikey",
    ...(template.label !== undefined ? { label: template.label } : {}),
    placements,
  };
};

/** Serialize a canonical method back into the request-shaped dialect — the
 *  write side of read-modify-write flows (stored configs and the catalog
 *  read as placements; auth INPUTS accept only this dialect). Same-named
 *  same-carrier placements collapse, exactly as the renderer's header/query
 *  records do. */
export const apiKeyAuthTemplateFromMethod = (method: {
  readonly slug?: string;
  readonly label?: string;
  readonly placements: readonly AuthPlacement[];
}): ApiKeyAuthTemplate => {
  const headers: Record<string, AuthTemplateValue> = {};
  const queryParams: Record<string, AuthTemplateValue> = {};
  for (const placement of method.placements) {
    const target = placement.carrier === "header" ? headers : queryParams;
    target[placement.name] =
      placement.literal !== undefined
        ? placement.literal
        : placement.prefix
          ? [placement.prefix, variable(placement.variable ?? TOKEN_VARIABLE)]
          : [variable(placement.variable ?? TOKEN_VARIABLE)];
  }
  return {
    ...(method.slug !== undefined ? { slug: method.slug } : {}),
    type: "apiKey",
    ...(method.label !== undefined ? { label: method.label } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
  };
};

/** Whether an input union member is the request-shaped dialect. */
export const isApiKeyAuthTemplate = (input: {
  readonly kind?: string;
  readonly type?: string;
}): input is ApiKeyAuthTemplate => input.type === "apiKey";
