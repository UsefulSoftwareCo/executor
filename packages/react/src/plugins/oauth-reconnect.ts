import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type { Connection, OAuthClientSummary } from "@executor-js/sdk/shared";

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

/** The stored OAuth app backing a connection, resolved from the loaded client
 *  summaries. First-party apps are config-declared and deployment-scoped, so
 *  they match on slug alone; stored rows are owner-scoped, matched against the
 *  app's stored owner (a Personal connection may be backed by a shared
 *  Workspace app). Undefined when the connection is not OAuth or its client
 *  row is gone (e.g. removed by hand). */
export function reconnectStoredClient(
  clients: readonly OAuthClientSummary[],
  connection: Connection,
): OAuthClientSummary | undefined {
  if (connection.oauthClient == null) return undefined;
  const slug = String(connection.oauthClient);
  const owner = connection.oauthClientOwner ?? connection.owner;
  return clients.find(
    (client) =>
      String(client.slug) === slug &&
      (client.origin.kind === "first_party" || client.owner === owner),
  );
}

/** Where an OAuth connection's Reconnect goes. */
export type ReconnectRoute =
  /** The client summaries have not loaded, so the stored binding is unknown.
   *  NO route may be chosen yet: guessing "direct" dead-ends an origin-drifted
   *  DCR client (#1542), and guessing "automatic" would rebind a manual app.
   *  The caller keeps the action unavailable until the summaries resolve. */
  | { readonly kind: "unknown" }
  /** Re-run the automatic probe/CIMD/DCR flow. `stored` is the binding's
   *  summary — undefined when its row is gone — so the handoff can carry its
   *  resource. */
  | { readonly kind: "automatic"; readonly stored: OAuthClientSummary | undefined }
  /** Start the OAuth flow directly against the stored client. */
  | { readonly kind: "direct" };

/** Decide the Reconnect route from the STORED client binding.
 *
 *  The binding's ORIGIN is what routes, not the method's capability flags:
 *  - An auto-minted DCR binding re-registers (its whole lifecycle is
 *    automatic, and the automatic flow can probe the token URL even when the
 *    method declares no discovery/DCR support). Reusing it directly dead-ends
 *    once the callback origin drifts (#1542).
 *  - A manual (static/BYO) or first-party binding keeps the direct
 *    stored-client path — re-registering would silently rebind the connection
 *    to an automatic client.
 *  - A binding whose row is GONE has nothing to start directly against, so it
 *    re-registers when the method supports the automatic flow at all.
 *  Pass `clients: undefined` while the summaries are loading: the decision is
 *  then `"unknown"`, never a guess. */
export function reconnectRoute(
  clients: readonly OAuthClientSummary[] | undefined,
  connection: Connection,
  methodSupportsAutomatic: boolean,
): ReconnectRoute {
  if (clients === undefined) return { kind: "unknown" };
  const stored = reconnectStoredClient(clients, connection);
  if (stored !== undefined) {
    return stored.origin.kind === "dynamic_client_registration"
      ? { kind: "automatic", stored }
      : { kind: "direct" };
  }
  return methodSupportsAutomatic ? { kind: "automatic", stored: undefined } : { kind: "direct" };
}

/** Reconnect's view of the client-summaries query:
 *  - `"ready"` — a current successful load; routing reads these summaries.
 *  - `"loading"` — the query is in flight (first load, or a retry after a
 *    failure); the action waits, exactly as before.
 *  - `"failed"` — the query failed. Stale data from an earlier success NEVER
 *    routes: a binding changed since that snapshot can misroute (repeat the
 *    origin-drift dead end, or treat a client absent from the snapshot as
 *    vanished and rebind it). The menu item surfaces the failure instead of
 *    sitting silently disabled, and opening the menu retries the query (see
 *    `retryReconnectClientsOnMenuOpen`). */
export type ReconnectClientsView =
  | { readonly kind: "ready"; readonly clients: readonly OAuthClientSummary[] }
  | { readonly kind: "loading" }
  | { readonly kind: "failed" };

/** Fold the summaries query into Reconnect's availability. Only a current
 *  Success is ready — a Failure reads as failed even when it retains a
 *  `previousSuccess`. A failure that is `waiting` is a retry in flight, so it
 *  reads as loading, not failed. */
export function reconnectClientsView(
  result: AsyncResult.AsyncResult<readonly OAuthClientSummary[], unknown>,
): ReconnectClientsView {
  if (AsyncResult.isSuccess(result)) return { kind: "ready", clients: result.value };
  if (AsyncResult.isFailure(result) && !result.waiting) return { kind: "failed" };
  return { kind: "loading" };
}

/** Recovery for the failed view: OPENING the row menu retries the query, so a
 *  transient listClients error never leaves Reconnect dead for the mounted
 *  lifetime. Only the failed view refetches — ready and loading views must
 *  not restart a request that already has data or is already running. */
export function retryReconnectClientsOnMenuOpen(
  open: boolean,
  view: ReconnectClientsView,
  retry: () => void,
): void {
  if (open && view.kind === "failed") retry();
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
 *  integration like PostHog declares hundreds): requested broadly to unlock as many
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
