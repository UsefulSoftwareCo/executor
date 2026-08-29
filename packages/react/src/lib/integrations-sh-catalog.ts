// ---------------------------------------------------------------------------
// integrations.sh catalog client — the connect dialog's long-tail search.
//
// The curated presets stay the featured list; this module reaches the rest of
// the public registry. Search stays server-side (`/api/search`, edge-cached)
// so the client never downloads the full multi-thousand-entry catalog, and the
// per-domain surface document is fetched only when the user picks a result,
// to resolve the URL the add form needs (MCP endpoint, OpenAPI spec URL, or
// GraphQL endpoint).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { getDomain } from "tldts";
import type { IntegrationPlugin } from "@executor-js/sdk/client";

export const INTEGRATIONS_SH_ORIGIN = "https://integrations.sh";

/** Registry kinds executor can connect (the registry also lists CLIs). Kind
 *  strings deliberately match the plugin keys. */
export const CONNECTABLE_KINDS = ["mcp", "openapi", "graphql"] as const;
export type CatalogKind = (typeof CONNECTABLE_KINDS)[number];

const isConnectableKind = (kind: string): kind is CatalogKind =>
  (CONNECTABLE_KINDS as readonly string[]).includes(kind);

/** One connectable surface of a domain, as the registry reports it.
 *
 *  `slug` is the registry's stable identifier for THIS surface, and it is the
 *  namespace the add flow seeds — which makes it the honest answer to "have I
 *  added this already?". The domain is not: a vendor's surfaces can live on
 *  other hosts entirely (GitHub's MCP server is on api.githubcopilot.com), and
 *  one domain routinely offers several surfaces that are separate
 *  integrations. */
export interface CatalogSurface {
  readonly kind: CatalogKind;
  readonly slug: string;
  /** What to point the add flow at. Absent when the registry has no
   *  machine-readable locator, in which case the surface document still has to
   *  be fetched on click. */
  readonly url?: string;
  /** How to authenticate, for surfaces whose connect target cannot describe
   *  it itself — a GraphQL endpoint has no spec document, so the registry is
   *  the only carrier of facts like Linear's no-Bearer-prefix header. */
  readonly auth?: {
    readonly kind?: string;
    /** Header pattern, e.g. "Authorization: Bearer {token}". */
    readonly header?: string;
    readonly note?: string;
  };
  /** RFC 6902 JSON Patch the registry says to apply to the fetched spec —
   *  how a vendor's published document gets improved without hosting a fork
   *  (e.g. Neon's console session cookies posing as security schemes). */
  readonly specOverrides?: readonly unknown[];
}

export interface CatalogSearchEntry {
  readonly domain: string;
  /** The product's display name, when the row is a named product rather than
   *  a bare domain — "Outlook Mail" on graph.microsoft.com. */
  readonly name?: string;
  readonly description: string;
  readonly kinds: readonly CatalogKind[];
  /** Present on registries new enough to report it; absent responses fall back
   *  to resolving the surface document per click. */
  readonly surfaces?: readonly CatalogSurface[];
}

export const catalogLogoUrl = (domain: string, size: number): string =>
  `${INTEGRATIONS_SH_ORIGIN}/logo/${domain}?sz=${size * 2}`;

class CatalogRequestError extends Data.TaggedError("CatalogRequestError")<{
  readonly message: string;
}> {}

const fetchCatalogJson = (url: URL): Effect.Effect<unknown, CatalogRequestError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      // ALWAYS REVALIDATE. The catalog is a live service and its corrections
      // must reach the console immediately, but the browser will honour
      // whatever max-age the response carried when it was stored — a stale
      // entry with a long TTL kept showing a domain that had been merged away
      // and an MCP endpoint that does not exist, hours after the fix shipped.
      // `no-cache` still sends the conditional request, so a 304 costs nothing
      // when nothing has changed.
      try: () => fetch(url, { cache: "no-cache" }),
      catch: () => new CatalogRequestError({ message: `Failed to reach ${url.host}.` }),
    });
    if (!response.ok) {
      return yield* new CatalogRequestError({
        message: `Unexpected status ${response.status} from ${url.host}.`,
      });
    }
    return yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => new CatalogRequestError({ message: "Response was not valid JSON." }),
    });
  });

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const SearchResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      domain: Schema.String,
      name: Schema.optional(Schema.String),
      description: Schema.String,
      kinds: Schema.Array(Schema.String),
      surfaces: Schema.optional(
        Schema.Array(
          Schema.Struct({
            kind: Schema.String,
            slug: Schema.String,
            url: Schema.optional(Schema.String),
            auth: Schema.optional(
              Schema.Struct({
                kind: Schema.optional(Schema.String),
                header: Schema.optional(Schema.String),
                note: Schema.optional(Schema.String),
              }),
            ),
            specOverrides: Schema.optional(Schema.Array(Schema.Unknown)),
          }),
        ),
      ),
    }),
  ),
});
const decodeSearchResponse = Schema.decodeUnknownOption(SearchResponse);

export const parseCatalogSearch = (payload: unknown): readonly CatalogSearchEntry[] =>
  Option.match(decodeSearchResponse(payload), {
    onNone: () => [],
    onSome: ({ results }) =>
      results
        .map((entry) => {
          const surfaces = (entry.surfaces ?? []).flatMap((surface): readonly CatalogSurface[] =>
            isConnectableKind(surface.kind)
              ? [
                  {
                    kind: surface.kind,
                    slug: surface.slug,
                    ...(surface.url ? { url: surface.url } : {}),
                    ...(surface.auth ? { auth: surface.auth } : {}),
                    ...(surface.specOverrides && surface.specOverrides.length > 0
                      ? { specOverrides: surface.specOverrides }
                      : {}),
                  },
                ]
              : [],
          );
          return {
            domain: entry.domain,
            ...(entry.name && entry.name !== entry.domain ? { name: entry.name } : {}),
            description: entry.description,
            kinds: entry.kinds.filter(isConnectableKind),
            ...(surfaces.length > 0 ? { surfaces } : {}),
          };
        })
        .filter((entry) => entry.kinds.length > 0),
  });

export interface CatalogQuery {
  /** Free text. EMPTY IS MEANINGFUL: the registry answers an empty query with
   *  its popularity-ordered head, which is what a browse view wants. */
  readonly query: string;
  /** Restrict to one surface kind. Omitted means every connectable kind. */
  readonly kind?: CatalogKind;
  /** The registry caps this at 100. */
  readonly limit?: number;
  /** Ranked results to skip — how the picker pages an endless list. */
  readonly offset?: number;
}

export const searchCatalog = (
  input: CatalogQuery,
): Effect.Effect<readonly CatalogSearchEntry[], CatalogRequestError> => {
  const url = new URL("/api/search", INTEGRATIONS_SH_ORIGIN);
  url.searchParams.set("q", input.query);
  url.searchParams.set("limit", String(input.limit ?? 10));
  if (input.kind) url.searchParams.set("kind", input.kind);
  if (input.offset) url.searchParams.set("offset", String(input.offset));
  return Effect.map(fetchCatalogJson(url), parseCatalogSearch);
};

// ---------------------------------------------------------------------------
// Connect-target resolution (per-domain surface document)
// ---------------------------------------------------------------------------

const SurfaceDocument = Schema.Struct({
  surfaces: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      slug: Schema.optional(Schema.String),
      url: Schema.optional(Schema.String),
      spec: Schema.optional(Schema.String),
    }),
  ),
});
const decodeSurfaceDocument = Schema.decodeUnknownOption(SurfaceDocument);

type SurfaceRecord = (typeof SurfaceDocument.Type)["surfaces"][number];

export interface CatalogConnectTarget {
  readonly kind: CatalogKind;
  /** What the add form's URL field expects: the MCP endpoint, the OpenAPI
   *  spec URL, or the GraphQL endpoint. */
  readonly url: string;
  /** The registry's stable slug for the surface — seeds the namespace field. */
  readonly slug?: string;
}

// The surface document's `type` vocabulary: OpenAPI surfaces are `http` (spec
// present ⇒ machine-readable), and `spec` on a GraphQL surface is an SDL
// pointer or the literal "introspection" — the endpoint is what executor adds.
const connectUrlOf = (surface: SurfaceRecord, kind: CatalogKind): string | undefined =>
  kind === "mcp" && surface.type === "mcp"
    ? surface.url
    : kind === "openapi" && surface.type === "http"
      ? surface.spec
      : kind === "graphql" && surface.type === "graphql"
        ? surface.url
        : undefined;

export const pickConnectTarget = (
  payload: unknown,
  kind: CatalogKind,
): CatalogConnectTarget | undefined =>
  Option.match(decodeSurfaceDocument(payload), {
    onNone: () => undefined,
    onSome: ({ surfaces }) => {
      for (const surface of surfaces) {
        const url = connectUrlOf(surface, kind);
        if (url) return { kind, url, ...(surface.slug ? { slug: surface.slug } : {}) };
      }
      return undefined;
    },
  });

/** The connect target for the first of `kinds` (caller's preference order)
 *  that has a usable locator in the domain's surface document. */
export const resolveConnectTarget = (
  domain: string,
  kinds: readonly CatalogKind[],
): Effect.Effect<CatalogConnectTarget | undefined, CatalogRequestError> => {
  const url = new URL(`/api/${encodeURIComponent(domain)}/surface`, INTEGRATIONS_SH_ORIGIN);
  return Effect.map(fetchCatalogJson(url), (payload) => {
    for (const kind of kinds) {
      const target = pickConnectTarget(payload, kind);
      if (target) return target;
    }
    return undefined;
  });
};

// ---------------------------------------------------------------------------
// Filtering against the curated presets
// ---------------------------------------------------------------------------

/** Domains already represented by a loaded plugin's presets, so the catalog
 *  section doesn't repeat what the preset list above it already shows. */
/** The domain a preset represents, read from its integrations.sh logo URL
 *  first (which names the domain outright) and its spec/endpoint URL second. */
export const presetDomain = (preset: {
  readonly icon?: string;
  readonly url?: string;
}): string | null => {
  for (const candidate of [preset.icon, preset.url]) {
    if (!candidate) continue;
    const logoMatch = /^https:\/\/integrations\.sh\/logo\/([^/?]+)/.exec(candidate);
    const domain = logoMatch?.[1] ?? getDomain(candidate);
    if (domain) return domain;
  }
  return null;
};

export const presetDomains = (plugins: readonly IntegrationPlugin[]): ReadonlySet<string> => {
  const domains = new Set<string>();
  for (const plugin of plugins) {
    for (const preset of plugin.presets ?? []) {
      const domain = presetDomain(preset);
      if (domain) domains.add(domain);
    }
  }
  return domains;
};

/** Kinds this deployment can actually add — the plugin key vocabulary matches
 *  the catalog kind vocabulary. */
export const availableCatalogKinds = (
  plugins: readonly IntegrationPlugin[],
): readonly CatalogKind[] =>
  CONNECTABLE_KINDS.filter((kind) => plugins.some((plugin) => plugin.key === kind));

export const filterCatalogEntries = (
  entries: readonly CatalogSearchEntry[],
  opts: {
    readonly excludeDomains: ReadonlySet<string>;
    readonly availableKinds: readonly CatalogKind[];
  },
): readonly CatalogSearchEntry[] =>
  entries
    .filter((entry) => !opts.excludeDomains.has(entry.domain))
    .map((entry) => ({
      ...entry,
      kinds: entry.kinds.filter((kind) => opts.availableKinds.includes(kind)),
      ...(entry.surfaces
        ? { surfaces: entry.surfaces.filter((s) => opts.availableKinds.includes(s.kind)) }
        : {}),
    }))
    .filter((entry) => entry.kinds.length > 0);

// ---------------------------------------------------------------------------
// Hook — debounced search with an in-session response cache
// ---------------------------------------------------------------------------

const SEARCH_DEBOUNCE_MS = 250;
/** Free-text queries wait for a second character; a browse (empty query) does
 *  not, because there is nothing to narrow. */
const MIN_QUERY_LENGTH = 2;
const BROWSE_LIMIT = 60;

export interface CatalogSearchState {
  readonly entries: readonly CatalogSearchEntry[];
  readonly loading: boolean;
  /** The registry could not be reached. The rest of the page still works, so
   *  this is a section-level notice rather than a page error. */
  readonly failed: boolean;
  /** The last page came back full, so more rows likely exist. */
  readonly hasMore: boolean;
  /** A further page is being fetched and appended. */
  readonly loadingMore: boolean;
  /** Fetch the next page. Safe to call repeatedly: no-op while a page is in
   *  flight or once the catalog is exhausted. */
  readonly loadMore: () => void;
}

const cacheKey = (input: CatalogQuery): string =>
  `${input.kind ?? "all"}:${input.limit ?? 0}:${input.query}`;
/** Responses are cached for as long as the registry says they are fresh, and
 *  no longer. The first version of this cache had no expiry at all, so a
 *  session that searched once kept that answer for its whole life — a registry
 *  correction could ship and the console would keep showing the old catalog
 *  until the tab was closed. */
const SEARCH_TTL_MS = 60_000;
const searchCache = new Map<
  string,
  { readonly at: number; readonly entries: readonly CatalogSearchEntry[] }
>();

/**
 * Browse or search the public registry.
 *
 * One hook for both because they are the same request with a different `q`:
 * an empty query returns the popularity-ordered head, a non-empty one filters
 * it. Search stays server-side and edge-cached, so no view ever downloads the
 * multi-thousand-entry catalog.
 */
export function useCatalogBrowse(input: CatalogQuery): CatalogSearchState {
  const query = input.query.trim().toLowerCase();
  const kind = input.kind;
  const limit = input.limit ?? BROWSE_LIMIT;
  const [state, setState] = useState<{
    readonly entries: readonly CatalogSearchEntry[];
    readonly loading: boolean;
    readonly failed: boolean;
  }>({ entries: [], loading: true, failed: false });
  const generation = useRef(0);

  const requestKey = cacheKey({ query, limit, ...(kind ? { kind } : {}) });
  // Pages beyond the first, keyed to the request they extend so a keystroke
  // discards them with the first page rather than leaking into new results.
  const [more, setMore] = useState<{
    readonly key: string;
    readonly entries: readonly CatalogSearchEntry[];
    readonly loadingMore: boolean;
    readonly exhausted: boolean;
  }>({ key: requestKey, entries: [], loadingMore: false, exhausted: false });

  useEffect(() => {
    const requestId = ++generation.current;
    // A partial word is not yet a query; leave the previous results in place
    // rather than flashing an empty list between keystrokes.
    if (query.length > 0 && query.length < MIN_QUERY_LENGTH) {
      setState((previous) => ({ ...previous, loading: false }));
      return;
    }
    const request: CatalogQuery = { query, limit, ...(kind ? { kind } : {}) };
    const cached = searchCache.get(cacheKey(request));
    if (cached && Date.now() - cached.at < SEARCH_TTL_MS) {
      setState({ entries: cached.entries, loading: false, failed: false });
      return;
    }
    setState((previous) => ({ ...previous, loading: true }));
    const timer = setTimeout(
      () => {
        void Effect.runPromiseExit(searchCatalog(request)).then((exit) => {
          if (Exit.isSuccess(exit)) {
            searchCache.set(cacheKey(request), { at: Date.now(), entries: exit.value });
          }
          if (generation.current !== requestId) return;
          setState({
            entries: Exit.isSuccess(exit) ? exit.value : [],
            loading: false,
            failed: Exit.isFailure(exit),
          });
        });
      },
      // The first browse should not sit behind a debounce meant for typing.
      query.length === 0 ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [query, kind, limit]);

  const extras = more.key === requestKey ? more : null;
  const baseCount = state.entries.length;
  const extraCount = extras?.entries.length ?? 0;
  const hasMore =
    !state.loading &&
    !state.failed &&
    baseCount >= limit &&
    !(extras?.exhausted ?? false) &&
    !(query.length > 0 && query.length < MIN_QUERY_LENGTH);

  const loadMore = useCallback(() => {
    if (!hasMore || (extras?.loadingMore ?? false)) return;
    setMore((previous) =>
      previous.key === requestKey
        ? { ...previous, loadingMore: true }
        : { key: requestKey, entries: [], loadingMore: true, exhausted: false },
    );
    const request: CatalogQuery = {
      query,
      limit,
      offset: baseCount + extraCount,
      ...(kind ? { kind } : {}),
    };
    void Effect.runPromiseExit(searchCatalog(request)).then((exit) => {
      setMore((previous) => {
        if (previous.key !== requestKey) return previous;
        const page = Exit.isSuccess(exit) ? exit.value : [];
        return {
          key: requestKey,
          entries: [...previous.entries, ...page],
          loadingMore: false,
          // A failed fetch is not the end of the catalog; the sentinel will
          // simply try again the next time it scrolls into view.
          exhausted: Exit.isSuccess(exit) && page.length < limit,
        };
      });
    });
  }, [hasMore, extras?.loadingMore, requestKey, query, kind, limit, baseCount, extraCount]);

  const entries = useMemo(() => {
    if (!extras || extras.entries.length === 0) return state.entries;
    // Ranking can shift between page fetches (the live index moves); a row
    // that slid across a page boundary must not render twice.
    const seen = new Set(state.entries.map((entry) => `${entry.domain}|${entry.name ?? ""}`));
    return [
      ...state.entries,
      ...extras.entries.filter((entry) => {
        const key = `${entry.domain}|${entry.name ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    ];
  }, [state.entries, extras]);

  return {
    entries,
    loading: state.loading,
    failed: state.failed,
    hasMore,
    loadingMore: extras?.loadingMore ?? false,
    loadMore,
  };
}

// ---------------------------------------------------------------------------
// Credential guidance
//
// The per-domain surface document records, for each way of authenticating,
// what the credential is called at the provider, the page that mints it, and
// the provider's own setup steps. The console fetched this document for its
// connect URL and discarded the rest — which is why the add-connection modal
// could not answer "what kind of key do I need?" or "where do I get one?"
// while asking for exactly that.
// ---------------------------------------------------------------------------

export interface CredentialGuidance {
  readonly id: string;
  readonly type: string;
  /** What the provider calls this credential ("Personal API key"). */
  readonly label: string;
  /** The page that mints it. */
  readonly generateUrl?: string;
  /** The provider's own instructions, as markdown. */
  readonly setup?: string;
}

const CredentialsDocument = Schema.Struct({
  credentials: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        type: Schema.optional(Schema.String),
        label: Schema.optional(Schema.String),
        generateUrl: Schema.optional(Schema.String),
        setup: Schema.optional(Schema.String),
      }),
    ),
  ),
});
const decodeCredentials = Schema.decodeUnknownOption(CredentialsDocument);

export const fetchCredentialGuidance = (
  domain: string,
): Effect.Effect<readonly CredentialGuidance[], CatalogRequestError> => {
  const url = new URL(`/api/${encodeURIComponent(domain)}/surface`, INTEGRATIONS_SH_ORIGIN);
  return Effect.map(fetchCatalogJson(url), (payload) =>
    Option.match(decodeCredentials(payload), {
      onNone: () => [],
      onSome: ({ credentials }) =>
        Object.entries(credentials ?? {}).map(([id, value]) => ({
          id,
          type: value.type ?? "unknown",
          label: value.label ?? id,
          ...(value.generateUrl ? { generateUrl: value.generateUrl } : {}),
          ...(value.setup ? { setup: value.setup } : {}),
        })),
    }),
  );
};

const guidanceCache = new Map<string, readonly CredentialGuidance[]>();

/** Guidance for a domain, or an empty list when the registry has none. Never
 *  fails loudly: this is help text, and a connection form must work without it. */
export function useCredentialGuidance(domain: string | null): readonly CredentialGuidance[] {
  const [state, setState] = useState<readonly CredentialGuidance[]>([]);

  useEffect(() => {
    if (!domain) {
      setState([]);
      return;
    }
    const cached = guidanceCache.get(domain);
    if (cached) {
      setState(cached);
      return;
    }
    let live = true;
    void Effect.runPromiseExit(fetchCredentialGuidance(domain)).then((exit) => {
      const value = Exit.isSuccess(exit) ? exit.value : [];
      guidanceCache.set(domain, value);
      if (live) setState(value);
    });
    return () => {
      live = false;
    };
  }, [domain]);

  return state;
}
