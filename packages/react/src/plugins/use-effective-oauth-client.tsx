import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import {
  OAuthClientSlug,
  type IntegrationSlug,
  type OAuthClientOrigin,
  type Owner,
} from "@executor-js/sdk/shared";
import { getDomain } from "tldts";

import { oauthClientsOptimisticAtom } from "../api/atoms";

// ---------------------------------------------------------------------------
// OAuth client (registered app) selection for an integration's connect flow.
//
// An owner can register MANY apps; each is a distinct owner-scoped `oauth_client`
// row with its own slug. The connect flow lists the MANUAL apps usable for an
// integration and lets the user pick one or register a new one. Matching is by
// recorded intent first (an app registered from this integration's dialog, or
// whose OAuth endpoint HOST exactly matches the integration's declared host),
// then by registrable root domain as a subdued near-miss tier. User-owned apps
// are listed before workspace ones.
//
// DCR (dynamic client registration) clients are plumbing, not apps: they are
// minted automatically and reused per authorization server, so they NEVER appear
// in this picker. They stay visible for management elsewhere (the modal's
// "Auto-registered clients" surface), keyed off `origin.kind`.
// ---------------------------------------------------------------------------

export interface OAuthClientOption {
  readonly owner: Owner;
  readonly slug: OAuthClientSlug;
  readonly grant: "authorization_code" | "client_credentials";
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  /** How the app came to exist. `manual` apps are pickable (with `integration`
   *  recording which dialog registered them); `dynamic_client_registration`
   *  apps are excluded from the picker entirely. */
  readonly origin: OAuthClientOrigin;
}

/** True for the auto-minted DCR clients that must never surface in the app
 *  picker. Legacy null-origin rows are already classified by the backend's
 *  `parseOAuthClientOrigin` heuristic, so this reads the parsed kind directly. */
export const isDcrClient = (app: OAuthClientOption): boolean =>
  app.origin.kind === "dynamic_client_registration";

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
const getRootDomain = (url: string): string | undefined => {
  const root = getDomain(url);
  if (root) return root.toLowerCase();
  return hostOf(url);
};

export interface UseOAuthClientsResult {
  /** Tier 1 — apps that match this integration by RECORDED INTENT (registered
   *  from its dialog) or EXACT endpoint host, user-owned first. These are the
   *  apps that belong to this integration; the picker defaults to the first one.
   *  When an endpoint was declared but nothing matched exactly, this is EMPTY. */
  readonly clients: readonly OAuthClientOption[];
  /** Tier 2 — apps that only match by registrable root domain (a near-miss: same
   *  provider family, different exact host / not stamped to this integration).
   *  Surfaced in a visually separate, subdued "Other apps on this provider"
   *  section — NEVER silently mixed into `clients`. Present whenever there are
   *  such near-misses, even when tier 1 is non-empty. */
  readonly nearMatches: readonly OAuthClientOption[];
  /** Unrelated apps (different root domain), kept only as the opt-in escape hatch
   *  ("use a different registered app") when NOTHING matched the declared
   *  endpoint at all. Empty once anything in tier 1 or tier 2 matched. */
  readonly otherClients: readonly OAuthClientOption[];
  /** True until the clients list has loaded at least once. */
  readonly loading: boolean;
  /**
   * Whether an app is EXACT-matched (tier 1) to the integration.
   *
   * - `true`  — either no endpoint filter was requested (the integration
   *   declares no endpoints), or at least one app matched by recorded intent or
   *   exact endpoint host. `clients` is that tier-1 subset.
   * - `false` — the integration declared endpoint(s) but no app matched exactly.
   *   `clients` is EMPTY (the UI shows an empty state + a register CTA). Any
   *   root-domain near-misses are still offered via `nearMatches`; truly
   *   unrelated apps via `otherClients`.
   */
  readonly endpointMatched: boolean;
  /** Convenience flag for the UI: a register-an-app CTA should be shown because
   *  an endpoint was declared and nothing exact-matched. Equals `!endpointMatched`
   *  once loaded. */
  readonly displayRegisterCTA: boolean;
}

/** Sort apps user-owned first (so the user's own apps surface before shared
 *  workspace apps). */
const sortUserFirst = (apps: readonly OAuthClientOption[]): readonly OAuthClientOption[] =>
  [...apps].sort((a: OAuthClientOption, b: OAuthClientOption) =>
    a.owner === b.owner ? 0 : a.owner === "user" ? -1 : 1,
  );

/**
 * Pure matcher (no React/atoms) — split owner-visible apps into three honest
 * tiers for an integration's connect picker.
 *
 * FIRST, DCR clients are dropped entirely: they are auto-minted plumbing reused
 * per authorization server, not apps a user picks. They stay manageable through
 * a separate surface, never the picker.
 *
 * Then the remaining MANUAL apps are graded:
 * - `matched` (tier 1): the app was registered from THIS integration's dialog
 *   (`origin.integration === integration`, recorded intent), OR its OAuth
 *   endpoint HOST exactly matches the integration's declared host (token host
 *   when a token endpoint is declared, else the authorize host). This is the
 *   subset that truly belongs to the integration.
 * - `nearMatches` (tier 2): the app shares the integration's REGISTRABLE ROOT
 *   DOMAIN ("tld+1") but is not a tier-1 match — a same-provider near-miss (e.g.
 *   an app on `mcp.cloudflare.com` for a REST integration on `api.cloudflare.com`).
 *   Silently promoting these into tier 1 is the bug this change fixes.
 * - `unmatched`: unrelated provider (different root), offered only as the escape
 *   hatch when nothing matched at all.
 *
 * When the integration declares no endpoints (and no match is required), every
 * manual app is tier 1 (no filter to grade against).
 */
export function selectClientsForEndpoints(
  all: readonly OAuthClientOption[],
  endpoints: {
    readonly tokenUrl?: string;
    readonly authorizationUrl?: string;
    /** The integration whose picker this is. A manual app stamped with this
     *  integration (recorded intent) is a tier-1 match regardless of host. */
    readonly integration?: IntegrationSlug;
    /** When set, an integration that targets a SPECIFIC server (MCP, whose
     *  endpoints are discovered at connect) must match by endpoint — absent
     *  endpoints mean NO match (show the register CTA), never "every app
     *  matches". Prevents auto-selecting an unrelated provider's app. */
    readonly requireEndpointMatch?: boolean;
  },
): {
  readonly matched: readonly OAuthClientOption[];
  readonly nearMatches: readonly OAuthClientOption[];
  readonly unmatched: readonly OAuthClientOption[];
  readonly endpointMatched: boolean;
} {
  // DCR clients are plumbing, never picker options.
  const manual = all.filter((app) => !isDcrClient(app));

  const intent = endpoints.integration;
  const matchesIntent = (app: OAuthClientOption): boolean =>
    intent != null &&
    app.origin.kind === "manual" &&
    app.origin.integration != null &&
    app.origin.integration === intent;

  const wantedTokenHost = endpoints.tokenUrl ? hostOf(endpoints.tokenUrl) : undefined;
  const wantedAuthorizationHost = endpoints.authorizationUrl
    ? hostOf(endpoints.authorizationUrl)
    : undefined;
  const wantedTokenRoot = endpoints.tokenUrl ? getRootDomain(endpoints.tokenUrl) : undefined;
  const wantedAuthorizationRoot = endpoints.authorizationUrl
    ? getRootDomain(endpoints.authorizationUrl)
    : undefined;

  // No declared endpoints. A server-targeting integration must NOT match every
  // app (it would auto-select an unrelated provider); surface the register CTA
  // instead. Otherwise (no endpoint filter at all) every manual app is usable.
  if (!wantedTokenRoot && !wantedAuthorizationRoot) {
    if (endpoints.requireEndpointMatch) {
      // Even with no declared endpoints, an app registered from THIS dialog is a
      // real tier-1 match (the user built it here on purpose).
      const matched = manual.filter(matchesIntent);
      const rest = manual.filter((app) => !matchesIntent(app));
      return {
        matched: sortUserFirst(matched),
        nearMatches: [],
        unmatched: sortUserFirst(rest),
        endpointMatched: matched.length > 0,
      };
    }
    return {
      matched: sortUserFirst(manual),
      nearMatches: [],
      unmatched: [],
      endpointMatched: true,
    };
  }

  const matched: OAuthClientOption[] = [];
  const nearMatches: OAuthClientOption[] = [];
  const unmatched: OAuthClientOption[] = [];
  for (const app of manual) {
    const appTokenHost = hostOf(app.tokenUrl);
    const appAuthorizationHost = hostOf(app.authorizationUrl);
    const appTokenRoot = getRootDomain(app.tokenUrl);
    const appAuthorizationRoot = getRootDomain(app.authorizationUrl);
    // Exact HOST match against the declared endpoint (token host first, since the
    // token endpoint is what the SDK actually calls; authorize host as fallback
    // when no token endpoint was declared).
    const exactHostMatch = wantedTokenHost
      ? appTokenHost === wantedTokenHost
      : appAuthorizationHost === wantedAuthorizationHost ||
        appTokenHost === wantedAuthorizationHost;
    // Same registrable root domain (the old, looser heuristic) — now only a
    // tier-2 signal.
    const rootMatch = wantedTokenRoot
      ? appTokenRoot === wantedTokenRoot
      : appAuthorizationRoot === wantedAuthorizationRoot ||
        appTokenRoot === wantedAuthorizationRoot;
    if (matchesIntent(app) || exactHostMatch) matched.push(app);
    else if (rootMatch) nearMatches.push(app);
    else unmatched.push(app);
  }
  return {
    matched: sortUserFirst(matched),
    nearMatches: sortUserFirst(nearMatches),
    unmatched: sortUserFirst(unmatched),
    endpointMatched: matched.length > 0,
  };
}

export function useOAuthClientsForIntegration(opts: {
  readonly tokenUrl?: string;
  readonly authorizationUrl?: string;
  readonly integration?: IntegrationSlug;
  readonly requireEndpointMatch?: boolean;
}): UseOAuthClientsResult {
  // Read the optimistic list so a just-registered/edited/removed app paints
  // immediately, instead of flashing the stale server list until the refetch
  // lands. The modal's management menu reads the same optimistic atom, so the
  // picker rows and their actions stay consistent.
  const clientsResult = useAtomValue(oauthClientsOptimisticAtom);
  if (!AsyncResult.isSuccess(clientsResult)) {
    return {
      clients: [],
      nearMatches: [],
      otherClients: [],
      loading: true,
      endpointMatched: true,
      displayRegisterCTA: false,
    };
  }

  const all = clientsResult.value as readonly OAuthClientOption[];
  const { matched, nearMatches, unmatched, endpointMatched } = selectClientsForEndpoints(all, {
    tokenUrl: opts.tokenUrl,
    authorizationUrl: opts.authorizationUrl,
    integration: opts.integration,
    requireEndpointMatch: opts.requireEndpointMatch,
  });
  // EXPLICIT outcome: `clients` is the tier-1 (exact/intent) subset the picker
  // defaults into. `nearMatches` (root-domain-only) is always surfaced, but in a
  // separate subdued section so it is never mistaken for a real match. When an
  // endpoint was declared but nothing exact-matched, `clients` is EMPTY and a
  // register CTA is flagged; the unrelated `unmatched` apps stay in `otherClients`
  // as the last-resort escape hatch.
  return {
    clients: endpointMatched ? matched : [],
    nearMatches,
    otherClients: endpointMatched ? [] : unmatched,
    loading: false,
    endpointMatched,
    displayRegisterCTA: !endpointMatched,
  };
}

/**
 * The auto-registered (DCR) clients relevant to an integration, for the
 * management surface (list + delete). These are hidden from the app picker but
 * must stay visible SOMEWHERE. A DCR client is relevant when it records this
 * integration as its origin (Part A stamps `origin.integration`), or — for
 * legacy clients minted before the stamp — when its endpoints share the
 * integration's declared/discovered root domain.
 */
export function selectDcrClientsForIntegration(
  all: readonly OAuthClientOption[],
  opts: {
    readonly integration?: IntegrationSlug;
    readonly tokenUrl?: string;
    readonly authorizationUrl?: string;
  },
): readonly OAuthClientOption[] {
  const wantedTokenRoot = opts.tokenUrl ? getRootDomain(opts.tokenUrl) : undefined;
  const wantedAuthorizationRoot = opts.authorizationUrl
    ? getRootDomain(opts.authorizationUrl)
    : undefined;
  const relevant = all.filter((app) => {
    if (!isDcrClient(app)) return false;
    if (
      opts.integration != null &&
      app.origin.kind === "dynamic_client_registration" &&
      app.origin.integration != null &&
      app.origin.integration === opts.integration
    ) {
      return true;
    }
    if (!wantedTokenRoot && !wantedAuthorizationRoot) return false;
    const appTokenRoot = getRootDomain(app.tokenUrl);
    const appAuthorizationRoot = getRootDomain(app.authorizationUrl);
    return (
      (wantedTokenRoot != null &&
        (appTokenRoot === wantedTokenRoot || appAuthorizationRoot === wantedTokenRoot)) ||
      (wantedAuthorizationRoot != null &&
        (appAuthorizationRoot === wantedAuthorizationRoot ||
          appTokenRoot === wantedAuthorizationRoot))
    );
  });
  return sortUserFirst(relevant);
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

/** Deterministic DCR client slug derived from the authorization server host. */
export function dcrClientSlug(issuerOrEndpoint: string): OAuthClientSlug {
  const host = hostOf(issuerOrEndpoint);
  const base = host === undefined ? "" : slugifyName(host);
  return OAuthClientSlug.make(`dcr-${base || "authorization-server"}`);
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
