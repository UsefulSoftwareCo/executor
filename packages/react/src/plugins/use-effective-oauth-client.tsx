import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import {
  type IntegrationSlug,
  OAuthClientSlug,
  type OAuthClientOrigin,
  type Owner,
} from "@executor-js/sdk/shared";
import { getDomain } from "tldts";

import { oauthClientsOptimisticAtom } from "../api/atoms";

// ---------------------------------------------------------------------------
// OAuth client (registered app) selection for an integration's connect flow.
//
// An owner can register MANY apps; each is a distinct owner-scoped `oauth_client`
// row with its own slug. The connect flow lists the apps usable for an
// integration and lets the user pick one or register a new one. An app is usable
// for an integration when EITHER:
//   - it was registered for that integration (`origin.integration`), OR
//   - its OAuth endpoints share a registrable root domain with the integration's
//     declared endpoints (so one app can be reused across sibling integrations).
// User-owned apps are listed before workspace ones. When the integration declares
// no endpoints AND owns no app (e.g. an MCP source whose endpoints are discovered
// at connect time), the picker shows an empty state + a "register an app" CTA
// rather than every unrelated provider's app — that broad leak was the bug behind
// "Datadog apps showing under Atlassian".
// ---------------------------------------------------------------------------

export interface OAuthClientOption {
  readonly owner: Owner;
  readonly slug: OAuthClientSlug;
  readonly grant: "authorization_code" | "client_credentials";
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  /** Provenance — `origin.integration` is the integration this app was registered
   *  for (DCR or manual), which the picker uses to surface the app for that
   *  integration even when no static endpoints are declared to match on. */
  readonly origin?: OAuthClientOrigin;
}

const hostOf = (url: string): string | undefined => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL() throws on invalid input; treat as "no host"
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
};

/** The registrable ("tld+1") root domain of a URL, e.g.
 *  `accounts.google.com` → `google.com`. Falls back to the full host for
 *  localhost / IP literals (where `tldts.getDomain` returns null) so local-dev
 *  MCP servers still match by exact host. Returns undefined for unparseable URLs. */
export const getRootDomain = (url: string): string | undefined => {
  const root = getDomain(url);
  if (root) return root.toLowerCase();
  return hostOf(url);
};

/** The integration an app was registered for, from either origin kind (or
 *  undefined). Used to surface an app for its integration even when no static
 *  endpoints are declared to match on. */
const appIntegration = (app: OAuthClientOption): string | undefined =>
  app.origin?.integration == null ? undefined : String(app.origin.integration);

export interface UseOAuthClientsResult {
  /** Apps usable for this integration, user-owned first. When an endpoint was
   *  declared but nothing matched, this is EMPTY (the unmatched apps move to
   *  `otherClients`). */
  readonly clients: readonly OAuthClientOption[];
  /** Unmatched owner-visible apps — surfaced only as an opt-in escape hatch
   *  ("use a different registered app") when no app matched the declared
   *  endpoint. Empty when `endpointMatched` is true. */
  readonly otherClients: readonly OAuthClientOption[];
  /** True until the clients list has loaded at least once. */
  readonly loading: boolean;
  /**
   * Whether the returned `clients` are matched to the integration's declared
   * OAuth endpoints (by registrable root domain across authorize + token).
   *
   * - `true`  — either no endpoint filter was requested (the integration
   *   declares no endpoints), or at least one registered app's authorize/token
   *   root domain matched. `clients` are the matched subset.
   * - `false` — the integration declared endpoint(s) but NO registered app
   *   matched. `clients` is then EMPTY (so the UI shows an empty state + a
   *   register CTA rather than unrelated providers' apps), and the unmatched
   *   apps are surfaced separately in `otherClients` for the opt-in escape hatch.
   */
  readonly endpointMatched: boolean;
  /** Convenience flag for the UI: a register-an-app CTA should be shown because
   *  an endpoint was declared and nothing matched. Equals `!endpointMatched`
   *  once loaded. */
  readonly displayRegisterCTA: boolean;
  /** Every owner-visible app, UNFILTERED. Callers that need the whole catalog
   *  (slug-collision avoidance when minting, duplicate-DCR reuse detection) read
   *  this rather than the integration-filtered `clients`. */
  readonly allClients: readonly OAuthClientOption[];
}

/** Sort apps user-owned first (so the user's own apps surface before shared
 *  workspace apps). */
const sortUserFirst = (apps: readonly OAuthClientOption[]): readonly OAuthClientOption[] =>
  [...apps].sort((a: OAuthClientOption, b: OAuthClientOption) =>
    a.owner === b.owner ? 0 : a.owner === "user" ? -1 : 1,
  );

/**
 * Pure matcher (no React/atoms) — split owner-visible apps into the ones usable
 * for an integration and the ones that aren't.
 *
 * An app is usable when EITHER signal holds:
 *   - INTEGRATION: it was registered for this integration (`origin.integration`
 *     equals `integration`). This is the only signal an MCP source has, since its
 *     OAuth endpoints are discovered at connect time and never declared.
 *   - ENDPOINT: the integration declares an endpoint and the app's endpoints share
 *     a REGISTRABLE ROOT DOMAIN ("tld+1"). The token endpoint is preferred (it is
 *     what the SDK calls during code exchange/refresh, avoiding authorize-root
 *     coincidences); the authorize root is the fallback when only it is declared.
 *     This lets one app be reused across sibling integrations of one provider.
 *
 * When NEITHER an integration nor any endpoint is known (no context at all), the
 * filter cannot discriminate and every app is "matched" (legacy fall-through).
 * Crucially, when an integration IS known but declares no endpoints, apps are
 * matched by integration only — unrelated providers' apps no longer leak in.
 */
export function selectClientsForEndpoints(
  all: readonly OAuthClientOption[],
  endpoints: {
    readonly integration?: string;
    readonly tokenUrl?: string;
    readonly authorizationUrl?: string;
  },
): {
  readonly matched: readonly OAuthClientOption[];
  readonly unmatched: readonly OAuthClientOption[];
  readonly endpointMatched: boolean;
} {
  const wantedIntegration = endpoints.integration;
  const wantedTokenRoot = endpoints.tokenUrl ? getRootDomain(endpoints.tokenUrl) : undefined;
  const wantedAuthorizationRoot = endpoints.authorizationUrl
    ? getRootDomain(endpoints.authorizationUrl)
    : undefined;
  // No discriminating signal at all → no filter; every app is usable.
  if (!wantedIntegration && !wantedTokenRoot && !wantedAuthorizationRoot) {
    return { matched: sortUserFirst(all), unmatched: [], endpointMatched: true };
  }
  const matched: OAuthClientOption[] = [];
  const unmatched: OAuthClientOption[] = [];
  for (const app of all) {
    const fitsIntegration =
      wantedIntegration !== undefined && appIntegration(app) === wantedIntegration;
    const appTokenRoot = getRootDomain(app.tokenUrl);
    const appAuthorizationRoot = getRootDomain(app.authorizationUrl);
    const fitsEndpoint = wantedTokenRoot
      ? appTokenRoot === wantedTokenRoot
      : wantedAuthorizationRoot
        ? appAuthorizationRoot === wantedAuthorizationRoot ||
          appTokenRoot === wantedAuthorizationRoot
        : false;
    if (fitsIntegration || fitsEndpoint) matched.push(app);
    else unmatched.push(app);
  }
  return {
    matched: sortUserFirst(matched),
    unmatched: sortUserFirst(unmatched),
    endpointMatched: matched.length > 0,
  };
}

export function useOAuthClientsForIntegration(opts: {
  readonly integration?: IntegrationSlug;
  readonly tokenUrl?: string;
  readonly authorizationUrl?: string;
}): UseOAuthClientsResult {
  // Read the optimistic list so a just-registered/edited/removed app paints
  // immediately, instead of flashing the stale server list until the refetch
  // lands. The modal's management menu reads the same optimistic atom, so the
  // picker rows and their actions stay consistent.
  const clientsResult = useAtomValue(oauthClientsOptimisticAtom);
  if (!AsyncResult.isSuccess(clientsResult)) {
    return {
      clients: [],
      otherClients: [],
      loading: true,
      endpointMatched: true,
      displayRegisterCTA: false,
      allClients: [],
    };
  }

  const all = clientsResult.value as readonly OAuthClientOption[];
  const { matched, unmatched, endpointMatched } = selectClientsForEndpoints(all, {
    integration: opts.integration ? String(opts.integration) : undefined,
    tokenUrl: opts.tokenUrl,
    authorizationUrl: opts.authorizationUrl,
  });
  // EXPLICIT outcome: when at least one app matched (or no endpoint was
  // declared) we present the matched subset. When an endpoint was declared but
  // nothing matched, `clients` is EMPTY — the unmatched apps move to
  // `otherClients` for an opt-in escape hatch — and we flag a register CTA so
  // the UI offers "register an app" instead of surfacing unrelated providers.
  return {
    clients: endpointMatched ? matched : [],
    otherClients: endpointMatched ? [] : unmatched,
    loading: false,
    endpointMatched,
    displayRegisterCTA: !endpointMatched,
    allClients: all,
  };
}

const slugifyName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** A unique OAuth client slug derived from a display name, deduped against the
 *  owner's existing client slugs. */
export function uniqueClientSlug(name: string, existing: readonly string[]): OAuthClientSlug {
  const base = slugifyName(name) || "oauth-app";
  if (!existing.includes(base)) return OAuthClientSlug.make(base);
  let suffix = 2;
  while (existing.includes(`${base}-${suffix}`)) suffix += 1;
  return OAuthClientSlug.make(`${base}-${suffix}`);
}

/** Humanize a client slug for display ("spotify-prod" → "Spotify prod"). */
export function clientDisplayName(slug: string): string {
  const text = slug.replace(/[-_]/g, " ").trim();
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : slug;
}

/** The host shown next to an app in the picker (the token endpoint's host). */
export function clientHost(tokenUrl: string): string {
  return hostOf(tokenUrl) ?? tokenUrl;
}
