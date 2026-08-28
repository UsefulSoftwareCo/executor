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

import { useEffect, useRef, useState } from "react";
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

export interface CatalogSearchEntry {
  readonly domain: string;
  readonly description: string;
  readonly kinds: readonly CatalogKind[];
}

export const catalogLogoUrl = (domain: string, size: number): string =>
  `${INTEGRATIONS_SH_ORIGIN}/logo/${domain}?sz=${size * 2}`;

class CatalogRequestError extends Data.TaggedError("CatalogRequestError")<{
  readonly message: string;
}> {}

const fetchCatalogJson = (url: URL): Effect.Effect<unknown, CatalogRequestError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(url),
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
      description: Schema.String,
      kinds: Schema.Array(Schema.String),
    }),
  ),
});
const decodeSearchResponse = Schema.decodeUnknownOption(SearchResponse);

export const parseCatalogSearch = (payload: unknown): readonly CatalogSearchEntry[] =>
  Option.match(decodeSearchResponse(payload), {
    onNone: () => [],
    onSome: ({ results }) =>
      results
        .map((entry) => ({
          domain: entry.domain,
          description: entry.description,
          kinds: entry.kinds.filter(isConnectableKind),
        }))
        .filter((entry) => entry.kinds.length > 0),
  });

export const searchCatalog = (
  query: string,
  limit = 10,
): Effect.Effect<readonly CatalogSearchEntry[], CatalogRequestError> => {
  const url = new URL("/api/search", INTEGRATIONS_SH_ORIGIN);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
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
export const presetDomains = (plugins: readonly IntegrationPlugin[]): ReadonlySet<string> => {
  const domains = new Set<string>();
  for (const plugin of plugins) {
    for (const preset of plugin.presets ?? []) {
      for (const candidate of [preset.icon, preset.url]) {
        if (!candidate) continue;
        const logoMatch = /^https:\/\/integrations\.sh\/logo\/([^/?]+)/.exec(candidate);
        const domain = logoMatch?.[1] ?? getDomain(candidate);
        if (domain) domains.add(domain);
      }
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
    }))
    .filter((entry) => entry.kinds.length > 0);

// ---------------------------------------------------------------------------
// Hook — debounced search with an in-session response cache
// ---------------------------------------------------------------------------

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;
const searchCache = new Map<string, readonly CatalogSearchEntry[]>();

export interface CatalogSearchState {
  readonly entries: readonly CatalogSearchEntry[];
  readonly loading: boolean;
}

export function useCatalogSearch(rawQuery: string): CatalogSearchState {
  const query = rawQuery.trim().toLowerCase();
  const [state, setState] = useState<CatalogSearchState>({ entries: [], loading: false });
  const generation = useRef(0);

  useEffect(() => {
    const requestId = ++generation.current;
    if (query.length < MIN_QUERY_LENGTH) {
      setState({ entries: [], loading: false });
      return;
    }
    const cached = searchCache.get(query);
    if (cached) {
      setState({ entries: cached, loading: false });
      return;
    }
    setState((previous) => ({ ...previous, loading: true }));
    const timer = setTimeout(() => {
      void Effect.runPromiseExit(searchCatalog(query)).then((exit) => {
        if (Exit.isSuccess(exit)) searchCache.set(query, exit.value);
        if (generation.current !== requestId) return;
        // Reachability is best-effort — the presets and URL detection above
        // the catalog section keep working without it.
        setState({ entries: Exit.isSuccess(exit) ? exit.value : [], loading: false });
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  return state;
}
