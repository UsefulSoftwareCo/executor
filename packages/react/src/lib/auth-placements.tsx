// ---------------------------------------------------------------------------
// Auth placements — "where does the credential go".
//
// Custom auth is concrete, not abstract: a method declares one or more
// PLACEMENTS. A placement says the carrier (HTTP header or query param), the
// name, an optional literal prefix (e.g. `Bearer `), and the input VARIABLE it
// renders from. A single-input method's placements all share the `token`
// variable (one secret, possibly in several spots); a multi-input method (e.g.
// Datadog's two keys) gives each placement its own variable, so an account fills
// one value per distinct variable.
//
// Serialize/parse to/from a plugin's wire auth-template (e.g. OpenAPI's
// `APIKeyAuthentication`) is plugin-specific and lives with the owning plugin —
// this module stays plugin-agnostic and only owns the generic placement shape
// and its presentational helpers.
// ---------------------------------------------------------------------------

import { AuthTemplateSlug } from "@executor-js/sdk/shared";
import type { AuthMethodDescriptor } from "@executor-js/sdk/shared";

export type Carrier = "header" | "query";

export interface Placement {
  readonly carrier: Carrier;
  /** Header name (e.g. `Authorization`) or query-param name (e.g. `api_key`). */
  readonly name: string;
  /** Literal prefix prepended to the secret, e.g. `Bearer `. May be empty. */
  readonly prefix: string;
  /** The input variable this placement renders from. Absent means "derive on
   *  serialize" — a lone input becomes the canonical `token`, multiple inputs
   *  each get a distinct variable. Two placements sharing a variable share one
   *  value. */
  readonly variable?: string;
}

/** A fresh, empty header placement — the default first row in an editor. */
export const emptyPlacement = (): Placement => ({ carrier: "header", name: "", prefix: "" });

/** What an auth method is, presentationally. `kind` drives the credential UI:
 *  `oauth` shows a Connect button, `none` creates a connection with no
 *  credential inputs, and apikey/custom fill secrets across `placements`.
 *  `source` distinguishes integration-declared ("spec") methods from
 *  user-defined ("custom") ones. `template` is the auth-template slug the
 *  method applies a connection through. */
export type AuthMethodKind = "oauth" | "apikey" | "custom" | "none";

/** Provider OAuth endpoints/scopes an `oauth` method declares, used to pre-fill
 *  the client-registration form so the user only pastes their client id/secret.
 *  Present only when `kind === "oauth"`; absent for credential methods. */
export interface AuthMethodOAuth {
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  readonly scopes?: readonly string[];
  /** RFC 7591 registration endpoint, when the provider advertises Dynamic
   *  Client Registration. Lets the form offer a one-click "Register
   *  automatically" path that needs no pasted client id/secret. */
  readonly registrationEndpoint?: string;
  /** For probe-at-connect providers (MCP): the endpoint to discover OAuth
   *  metadata from at connect time. When present, the connect flow probes this
   *  URL to resolve the authorize/token/registration endpoints live rather than
   *  relying on pre-resolved URLs. */
  readonly discoveryUrl?: string;
  /** True when the integration is known to support RFC 7591 dynamic client
   *  registration. Drives the transparent auto-register connect flow (probe →
   *  register → start, with no app picker). */
  readonly supportsDynamicRegistration?: boolean;
}

export interface AuthMethod {
  readonly id: string;
  readonly label: string;
  readonly kind: AuthMethodKind;
  readonly source: "spec" | "custom";
  readonly template: AuthTemplateSlug;
  readonly placements: readonly Placement[];
  /** Declared OAuth endpoints/scopes (only for `kind === "oauth"`). */
  readonly oauth?: AuthMethodOAuth;
}

/** Short human label for a placement: "Authorization header" / "api_key query
 *  param". Falls back to a generic noun when the name is blank. */
export function placementLabel(placement: Placement): string {
  if (placement.carrier === "header") {
    return `${placement.name || "Authorization"} header`;
  }
  return `${placement.name || "api_key"} query param`;
}

// ---------------------------------------------------------------------------
// PlacementLine — renders `Authorization: Bearer ••••••` / `?api_key=••••••`.
// The secret dots are accented; the prefix is faint; the whole line is mono.
// ---------------------------------------------------------------------------

export function PlacementLine(props: { readonly placement: Placement; readonly masked?: boolean }) {
  const { placement, masked = true } = props;
  const lead =
    placement.carrier === "header"
      ? `${placement.name || "Authorization"}: `
      : `?${placement.name || "api_key"}=`;
  return (
    <span className="inline-flex items-center font-mono text-xs text-muted-foreground">
      {lead}
      {placement.prefix ? (
        <span className="text-muted-foreground/60">{placement.prefix}</span>
      ) : null}
      <span className="tracking-widest text-primary">{masked ? "••••••" : "value"}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Catalog-descriptor → client AuthMethod conversion.
//
// The integration catalog response carries each integration's declared auth
// methods as plugin-agnostic `AuthMethodDescriptor[]` (derived server-side from
// the owning plugin's opaque config). This converts that wire shape into the
// presentational `AuthMethod[]` the hub renders — the single, plugin-agnostic
// home for the mapping so both the detail page and the add-account modal share
// it. `none` methods are kept: they create a named connection without
// credential inputs.
// ---------------------------------------------------------------------------

const DEFAULT_PLACEMENTS: readonly Placement[] = [
  { carrier: "header", name: "Authorization", prefix: "" },
];

/** Convert one catalog descriptor into a client `AuthMethod`. */
function authMethodFromDescriptor(descriptor: AuthMethodDescriptor): AuthMethod {
  const template = AuthTemplateSlug.make(descriptor.template);
  if (descriptor.kind === "none") {
    return {
      id: descriptor.id,
      label: descriptor.label,
      kind: "none",
      source: "spec",
      template,
      placements: [],
    };
  }
  if (descriptor.kind === "oauth") {
    const oauth = descriptor.oauth;
    return {
      id: descriptor.id,
      label: descriptor.label,
      kind: "oauth",
      source: "spec",
      template,
      placements: [],
      oauth: {
        authorizationUrl: oauth?.authorizationUrl,
        tokenUrl: oauth?.tokenUrl,
        scopes: oauth?.scopes,
        registrationEndpoint: oauth?.registrationEndpoint,
        discoveryUrl: oauth?.discoveryUrl,
        supportsDynamicRegistration: oauth?.supportsDynamicRegistration,
      },
    };
  }
  // "apikey" | "header" both render as a single-secret credential method; the
  // placements carry where the value is sent (defaulting to an Authorization
  // header when the plugin declares none).
  const placements: readonly Placement[] =
    descriptor.placements && descriptor.placements.length > 0
      ? descriptor.placements.map(
          (placement): Placement => ({
            carrier: placement.carrier,
            name: placement.name,
            prefix: placement.prefix,
            ...(placement.variable ? { variable: placement.variable } : {}),
          }),
        )
      : DEFAULT_PLACEMENTS;
  return {
    id: descriptor.id,
    label: descriptor.label,
    kind: "apikey",
    source: "spec",
    template,
    placements,
  };
}

/** Convert an integration's declared catalog descriptors into the client
 *  `AuthMethod[]` the hub renders. */
export function authMethodsFromDescriptors(
  descriptors: readonly AuthMethodDescriptor[],
): readonly AuthMethod[] {
  return descriptors.map(authMethodFromDescriptor);
}
