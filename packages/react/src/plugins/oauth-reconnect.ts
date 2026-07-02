import type { Connection } from "@executor-js/sdk/shared";

import type { OAuthStartPayload } from "./oauth-sign-in";

// ---------------------------------------------------------------------------
// OAuth scope helpers (pure) — shared by Reconnect (re-consent) and the connect
// modal's informational subset-scope warning. Kept React/atom-free so they are
// unit-testable in isolation.
// ---------------------------------------------------------------------------

/** How a connection should be re-connected:
 *  - `"oauth"` — it came from an OAuth flow (`oauthClient != null`); a token
 *    refresh CANNOT widen scopes and FAILS when there is no refresh token, so
 *    Reconnect must RE-RUN the OAuth flow (prompt=consent + the widened scope
 *    union), re-minting the SAME connection (owner/integration/name).
 *  - `"refresh"` — a static credential / non-OAuth connection; Reconnect is the
 *    existing token-refresh mutation. */
export type ReconnectMode = "oauth" | "refresh";

/** An OAuth connection carries the `oauthClient` slug that minted it; a static
 *  credential does not. That single field decides the Reconnect path. */
export function reconnectMode(connection: Connection): ReconnectMode {
  return connection.oauthClient != null ? "oauth" : "refresh";
}

/** Build the `oauth.start` payload that re-runs the OAuth flow for an existing
 *  OAuth connection. The branded `name`/`template`/`oauthClient` carried by the
 *  connection are exactly the branded types `oauth.start` expects, so the same
 *  connection (owner/integration/name) is re-minted with a fresh refresh token
 *  and the widened scope union. Returns null for a non-OAuth connection. */
export function oauthReconnectPayload(connection: Connection): OAuthStartPayload | null {
  if (connection.oauthClient == null) return null;
  return {
    client: connection.oauthClient,
    // The app's stored owner (a Personal connection may be backed by a shared
    // Workspace app); fall back to the connection owner for same-owner connects.
    clientOwner: connection.oauthClientOwner ?? connection.owner,
    owner: connection.owner,
    name: connection.name,
    integration: connection.integration,
    template: connection.template,
    identityLabel: connection.identityLabel ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Subset-scope warning (Part 2). At connect, when the chosen OAuth app's
// DECLARED scopes are a STRICT subset of the integration's declared scopes, the
// app grants fewer scopes than the integration needs. Connect already requests
// the UNION, so this is purely INFORMATIONAL: the gap is in the provider-app /
// GCP API enablement the user controls, surfaced so a rejected sign-in is
// explicable. Never blocks connect.
// ---------------------------------------------------------------------------

const OAUTH_SCOPE_ALIASES: Readonly<Record<string, string>> = {
  // Google accepts OIDC shorthand scopes but records the expanded People API
  // scopes in token responses. Treat them as the same grant for reconsent UI.
  "https://www.googleapis.com/auth/userinfo.email": "email",
  "https://www.googleapis.com/auth/userinfo.profile": "profile",
};

const canonicalScope = (scope: string): string => OAUTH_SCOPE_ALIASES[scope] ?? scope;

/** Normalize a scope list: trim, canonicalize known provider aliases, drop
 *  empties, de-dupe (order-preserving). A scope set is compared as a SET —
 *  duplicates and blanks never widen it. */
const normalizeScopes = (scopes: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of scopes) {
    const scope = canonicalScope(raw.trim());
    if (scope.length === 0 || seen.has(scope)) continue;
    seen.add(scope);
    out.push(scope);
  }
  return out;
};

/** Scopes in `needed` that `granted` does NOT cover — generic set difference
 *  (needed − granted), order-preserving. Empty when `granted` is a superset/equal
 *  or `needed` is empty. */
export function missingScopes(
  needed: readonly string[] | undefined,
  granted: readonly string[] | undefined,
): readonly string[] {
  const want = normalizeScopes(needed ?? []);
  if (want.length === 0) return [];
  const have = new Set(normalizeScopes(granted ?? []));
  return want.filter((scope: string) => !have.has(scope));
}

/** The scopes a connection was actually GRANTED, parsed from its space-delimited
 *  `oauthScope` record. Empty for static creds / when the AS omitted scope. */
export function connectionGrantedScopes(connection: Connection): readonly string[] {
  return connection.oauthScope ? connection.oauthScope.split(/\s+/).filter(Boolean) : [];
}

/** Whether an OAuth connection must RECONNECT to grant newly-needed access: the
 *  integration now DECLARES scopes the connection was not granted (e.g. after the
 *  integration added a service). Drives the "reconnect to grant access" prompt.
 *  Compares the integration's declared scopes (needed) against the connection's
 *  recorded grant — `oauth_scope` made load-bearing. False for non-OAuth
 *  connections and when the grant already covers everything declared. */
export function connectionNeedsReconsent(
  connection: Connection,
  declaredScopes: readonly string[] | undefined,
): boolean {
  if (connection.oauthClient == null) return false;
  return missingScopes(declaredScopes, connectionGrantedScopes(connection)).length > 0;
}

/** The scopes that count as REQUIRED for a connection to be considered fully
 *  granted, given the integration's oauth auth method.
 *
 *  Spec-derived oauth scopes are the full per-operation catalog union (an OpenAPI
 *  source like PostHog declares hundreds): requested broadly to unlock as many
 *  tools as possible, but none individually required. A provider that narrows the
 *  grant to the user's actual access is healthy, so the spec catalog must NOT
 *  drive a reconnect prompt. Custom (user-configured) scopes are intentional and
 *  stay required. Feed the result to `connectionNeedsReconsent`. */
export function reconsentRequiredScopes(
  method:
    | {
        readonly source: "spec" | "custom";
        readonly oauth?: { readonly scopes?: readonly string[] };
      }
    | undefined,
): readonly string[] | undefined {
  if (method == null || method.source === "spec") return undefined;
  return method.oauth?.scopes;
}
