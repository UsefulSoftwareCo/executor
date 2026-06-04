import type { AuthTemplateSlug } from "../ids";
import type { Integration } from "../integration";
import type { OAuthAuthentication } from "../oauth";

/* ───────────────────────  template variables  ─────────────────────── */

export type AuthenticationVariable = {
  type: "variable";
  name: string;
};

/** A literal string, or a parts-array mixing literals and variable refs. */
export type AuthenticationTemplateValue =
  | string
  | readonly (string | AuthenticationVariable)[];

export const variable = (name: string): AuthenticationVariable => ({
  type: "variable",
  name,
});

/* ─────────────────────────  auth templates  ───────────────────────────
 * The apiKey template is HTTP-transport-specific: it declares where the user's
 * credential goes on the outbound request (headers / query params) via the
 * `variable()` templating above. That placement is why it lives with the openapi
 * plugin rather than in core. The oauth template is mechanism-intrinsic and
 * comes from core (`OAuthAuthentication`); an integration's `Authentication`
 * union composes the two. Client credentials (clientId/secret) live on the core
 * `OAuthClient`, not here.
 */

export type APIKeyAuthentication = {
  slug: AuthTemplateSlug;
  type: "apiKey";
  headers?: Record<string, AuthenticationTemplateValue>;
  queryParams?: Record<string, AuthenticationTemplateValue>;
};

export type Authentication = OAuthAuthentication | APIKeyAuthentication;

/* ─────────────────────────  the integration  ──────────────────────────
 * The openapi integration kind. Extends the core `Integration` identity with
 * the auth templates a provider declares. This is the type-specific shape the
 * openapi plugin's `add` returns; core never references it.
 */

export type OpenAPIIntegration = Integration & {
  authenticationTemplate: Authentication[];
};
