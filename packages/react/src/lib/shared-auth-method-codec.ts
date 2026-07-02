// ---------------------------------------------------------------------------
// Shared auth-method codec — the one bridge between the canonical
// placements-based wire model (`@executor-js/sdk/http-auth`: apikey/none methods
// every protocol plugin stores) and the client's presentational shapes
// (`AuthMethod`, `Placement`, `AuthTemplateEditorValue`).
//
// OAuth methods are the only per-plugin wire variant (openapi stores
// endpoints+scopes, graphql a header override, mcp discovers at connect), so
// each plugin contributes a small OAUTH ADAPTER and composes everything else
// from here. This replaces the three per-plugin codec modules that each
// reimplemented (and disagreed on) the apikey path — MCP silently dropped all
// but the first placement, GraphQL split one method into N single-placement
// templates.
// ---------------------------------------------------------------------------

import { AuthTemplateSlug } from "@executor-js/sdk/shared";
import {
  TOKEN_VARIABLE,
  apiKeyAuthTemplateFromMethod,
  apiKeyMethodLabel,
  type ApiKeyAuthMethod,
  type ApiKeyAuthTemplate,
  type AuthPlacement,
  type NoneAuthMethod,
} from "@executor-js/sdk/http-auth";

import type { AuthTemplateEditorValue } from "../components/auth-template-editor";
import type { AuthMethod, Placement } from "./auth-placements";
import type { AuthMethodsCodec } from "./custom-auth-methods";

export type SharedAuthMethod = NoneAuthMethod | ApiKeyAuthMethod;

/** A method input the backend slugs itself (custom-method create flow). */
export type SharedAuthMethodInput =
  | { readonly slug?: string; readonly kind: "none" }
  | {
      readonly slug?: string;
      readonly kind: "apikey";
      readonly label?: string;
      readonly placements: readonly AuthPlacement[];
    };

export const isSharedAuthMethod = (template: {
  readonly kind: string;
}): template is SharedAuthMethod => template.kind === "apikey" || template.kind === "none";

// ---------------------------------------------------------------------------
// Wire placements ⇆ editor placements.
// ---------------------------------------------------------------------------

/** Wire → editor. The variable is made explicit (`token` when absent) so a
 *  round-trip preserves which placements share a credential input. */
export const editorPlacementsFromWire = (
  placements: readonly AuthPlacement[],
): readonly Placement[] =>
  placements.map(
    (placement: AuthPlacement): Placement => ({
      carrier: placement.carrier,
      name: placement.name,
      prefix: placement.prefix ?? "",
      ...(placement.literal !== undefined
        ? { literal: placement.literal }
        : { variable: placement.variable ?? TOKEN_VARIABLE }),
    }),
  );

/** Slugify a placement name into a variable identifier: `DD-API-KEY` →
 *  `dd_api_key`. */
const slugifyVariable = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** Assign an input variable to each named credential placement. A lone input
 *  is the canonical `token`; multiple inputs each get their own distinct
 *  variable so a connection carries a different value per location. An
 *  explicit `placement.variable` (from a round-trip) is honored — that is how
 *  two placements keep SHARING one input across an edit. */
const assignVariables = (placements: readonly Placement[]): Map<Placement, string> => {
  const named = placements.filter((p: Placement) => p.name.trim() && p.literal === undefined);
  const out = new Map<Placement, string>();
  if (named.length <= 1) {
    for (const p of named) out.set(p, p.variable ?? TOKEN_VARIABLE);
    return out;
  }
  // Explicit variables are kept VERBATIM — and may repeat: that is how two
  // placements share one credential input. Only derived names dedupe.
  const taken = new Set<string>();
  for (const p of named) {
    if (p.variable) {
      out.set(p, p.variable);
      taken.add(p.variable);
    }
  }
  for (const p of named) {
    if (p.variable) continue;
    const base = slugifyVariable(p.name) || "input";
    let candidate = base;
    let n = 2;
    while (taken.has(candidate)) candidate = `${base}_${n++}`;
    taken.add(candidate);
    out.set(p, candidate);
  }
  return out;
};

/** Editor → wire. Unnamed placements are dropped; the canonical `token`
 *  variable is stored as absent (the wire convention single-input connections
 *  depend on — their stored values are keyed `token`). */
export const wirePlacementsFromEditor = (
  placements: readonly Placement[],
): readonly AuthPlacement[] => {
  const variables = assignVariables(placements);
  return placements
    .filter(
      // `env` placements belong to stdio integrations, not the HTTP custom-
      // method editor this codec serializes; they never reach the wire here.
      (p: Placement): p is Placement & { readonly carrier: "header" | "query" } =>
        p.carrier !== "env" && (p.name.trim().length > 0 || p.literal !== undefined),
    )
    .map((p): AuthPlacement => {
      const variable = variables.get(p);
      return {
        carrier: p.carrier,
        name: p.name.trim(),
        ...(p.prefix ? { prefix: p.prefix } : {}),
        ...(p.literal !== undefined
          ? { literal: p.literal }
          : variable && variable !== TOKEN_VARIABLE
            ? { variable }
            : {}),
      };
    });
};

// ---------------------------------------------------------------------------
// Method ⇆ editor value / presentational method.
// ---------------------------------------------------------------------------

/** Convert one stored apikey/none method into the generic editor value. */
export const editorValueFromSharedMethod = (method: SharedAuthMethod): AuthTemplateEditorValue =>
  method.kind === "apikey"
    ? { kind: "apikey", placements: editorPlacementsFromWire(method.placements) }
    : { kind: "none" };

/** Convert an apikey/none editor value back into a method input (no slug —
 *  the backend assigns one). Returns null for oauth values: those convert
 *  through the plugin's oauth adapter. An apikey value with no usable
 *  placements degrades to `none`. */
export const sharedMethodInputFromEditorValue = (
  value: AuthTemplateEditorValue,
): SharedAuthMethodInput | null => {
  if (value.kind === "oauth") return null;
  if (value.kind === "none") return { kind: "none" };
  const placements = wirePlacementsFromEditor(value.placements);
  return placements.length > 0 ? { kind: "apikey", placements } : { kind: "none" };
};

/** Serialize an apikey method (stored or slug-optional) into the wire input
 *  dialect — auth INPUTS accept only the request-shaped template; stored
 *  configs and the catalog read as placements. Non-apikey arms pass through
 *  untouched. */
export const wireAuthInputFromShared = <T extends { readonly kind: string }>(
  method:
    | T
    | (Omit<ApiKeyAuthMethod, "slug"> & { readonly slug?: string; readonly kind: "apikey" }),
): T | ApiKeyAuthTemplate =>
  method.kind === "apikey"
    ? apiKeyAuthTemplateFromMethod(
        method as Omit<ApiKeyAuthMethod, "slug"> & { readonly slug?: string },
      )
    : (method as T);

const sourceOf = (slug: string): "spec" | "custom" =>
  slug.startsWith("custom_") ? "custom" : "spec";

/** Project one stored apikey/none method into the presentational `AuthMethod`
 *  the hub renders (mirrors the server's catalog projection). */
export const authMethodFromSharedTemplate = (method: SharedAuthMethod): AuthMethod => {
  if (method.kind === "apikey") {
    return {
      id: method.slug,
      label: apiKeyMethodLabel(method),
      kind: "apikey",
      source: sourceOf(method.slug),
      template: AuthTemplateSlug.make(method.slug),
      placements: editorPlacementsFromWire(method.placements),
    };
  }
  return {
    id: method.slug,
    label: "No authentication",
    kind: "none",
    source: sourceOf(method.slug),
    template: AuthTemplateSlug.make(method.slug),
    placements: [],
  };
};

// ---------------------------------------------------------------------------
// The codec factory for `useCustomMethodActions` — apikey/none handled here,
// oauth delegated to the plugin's adapter.
// ---------------------------------------------------------------------------

export interface SharedCodecOAuthAdapter<TOAuth extends { readonly slug: string }> {
  readonly isOAuth: (template: SharedAuthMethod | TOAuth) => template is TOAuth;
  readonly toAuthMethod: (template: TOAuth) => AuthMethod;
}

export function makeSharedAuthMethodCodec<TOAuth extends { readonly slug: string }>(
  adapter: SharedCodecOAuthAdapter<TOAuth>,
): AuthMethodsCodec<SharedAuthMethod | TOAuth> {
  return {
    toAuthMethods: (templates) =>
      templates.map((template) =>
        adapter.isOAuth(template)
          ? adapter.toAuthMethod(template)
          : authMethodFromSharedTemplate(template),
      ),
    templatesFromPlacements: (placements) => {
      const wire = wirePlacementsFromEditor(placements);
      if (wire.length === 0) return [];
      // Slug-less: the backend's merge assigns `custom_<id>`.
      return [{ slug: "", kind: "apikey", placements: wire } as ApiKeyAuthMethod];
    },
    slugOf: (template) => template.slug,
  };
}
