import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { PlusIcon, SearchIcon } from "lucide-react";
import type { Integration, IntegrationDetectionResult } from "@executor-js/sdk/shared";
import {
  useIntegrationPlugins,
  type IntegrationPlugin,
  type IntegrationPreset,
  type IntegrationQuickAddInput,
  type IntegrationQuickAddResult,
} from "@executor-js/sdk/client";

import { detectIntegration, integrationsOptimisticAtom } from "../api/atoms";
import { slugifyNamespace } from "../plugins/namespace";
import { trackEvent } from "../api/analytics";
import { Button } from "../components/button";
import { Input } from "../components/input";
import { PageContainer, PageHeader } from "../components/page";
import { Skeleton } from "../components/skeleton";
import { useExecutorDocumentTitle } from "../lib/document-title";
import {
  availableCatalogKinds,
  catalogLogoUrl,
  filterCatalogEntries,
  resolveConnectTarget,
  useCatalogBrowse,
  type CatalogKind,
  type CatalogSearchEntry,
  type CatalogSurface,
} from "../lib/integrations-sh-catalog";

// ---------------------------------------------------------------------------
// The full-page integration picker.
//
// Replaces the connect dialog. Finding something to connect is the first task
// of onboarding, so it gets a page and a permanent, focused search field rather
// than a 16rem scroll window behind a header button.
//
// ONE ROW PER ADDABLE THING. A service exposing both an API and an MCP server
// yields two rows, because they really are two different integrations with
// different tools and different auth — but each row NAMES its surface
// ("Stripe API", "Stripe MCP") rather than repeating the bare service name and
// leaving a badge to carry the difference. Two rows reading "Stripe" look like
// a duplicate; two rows reading "Stripe API" and "Stripe MCP" look like a
// choice, which is what they are.
//
// THE REGISTRY IS THE LIST. Every connectable card is a registry row: the
// registry carries the name, domain, description, spec or endpoint, auth
// facts, and corrective spec overrides, and the spec itself declares how to
// authenticate — a deployment's first-party OAuth clients bind at connect
// time by endpoint host, not through the picker. The one exception is
// presets WITHOUT a connect URL (local-process servers like Chrome DevTools
// over stdio): those cannot be registry rows yet, so they remain cards.
//
// FACETS ARE SURFACE KIND, NOT CATEGORY. There is no taxonomy to facet on, so a
// category rail would have to invent one. Kind is real, filtered server-side.
// ---------------------------------------------------------------------------

const KIND_TO_PLUGIN_KEY: Record<string, string> = {
  openapi: "openapi",
  mcp: "mcp",
  graphql: "graphql",
  googleDiscovery: "google",
};

const CATALOG_KIND_LABEL: Record<CatalogKind, string> = {
  mcp: "MCP",
  openapi: "OpenAPI",
  graphql: "GraphQL",
};

/** How a surface is said in a row's NAME. Deliberately not the facet
 *  vocabulary: a facet filters on the spec format ("OpenAPI"), while a name
 *  says the thing you would say out loud ("Stripe API"). */
const SURFACE_WORD: Record<string, string> = {
  mcp: "MCP",
  openapi: "API",
  google: "API",
  graphql: "GraphQL",
};

/** `Stripe` + API → `Stripe API`, but `GitHub REST` + API stays `GitHub REST`
 *  and `Emulate MCP` + MCP stays `Emulate MCP`. Appending a word the name
 *  already carries reads worse than leaving it off. */
const withSurface = (name: string, surface: string): string => {
  const lower = name.toLowerCase();
  const already =
    lower.includes(surface.toLowerCase()) ||
    (surface === "API" && (lower.includes("api") || lower.includes("rest")));
  return already ? name : `${name} ${surface}`;
};

/** The key on which a preset and a catalog row count as the same product:
 *  the name with surface words and punctuation stripped, plus the kind.
 *  "GitHub REST" and "GitHub API" are one product; "Stripe API" and
 *  "Stripe MCP" are not. */
const productKey = (name: string, kind: string): string =>
  `${name
    .toLowerCase()
    .replace(/\b(api|rest|graphql|mcp)\b/g, "")
    .replace(/[^a-z0-9]/g, "")}|${kind}`;

const detectionRank: Record<IntegrationDetectionResult["confidence"], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const bestDetection = (
  results: readonly IntegrationDetectionResult[],
): IntegrationDetectionResult | undefined =>
  [...results].sort((a, b) => detectionRank[b.confidence] - detectionRank[a.confidence])[0];

/** The input either names a thing to look for or points at one. Anything with
 *  a scheme, a slash, or a host-with-TLD is a URL; everything else is a query. */
const looksLikeUrl = (raw: string): boolean => {
  const value = raw.trim();
  if (value.length === 0) return false;
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(value)) return true;
  if (value.includes("/")) return true;
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?$/i.test(value)) return true;
  return false;
};

/** A readable product name for a bare domain: `gmail.googleapis.com` reads as
 *  "Gmail", `linear.app` as "Linear". The full domain still renders beside it,
 *  because two services can share a leading label and the domain is what
 *  actually disambiguates them. */
const domainDisplayName = (domain: string): string => {
  const host = domain.replace(/^www\./, "");
  const label = host.split(".")[0] ?? host;
  return label.charAt(0).toUpperCase() + label.slice(1);
};

/** The registry truncates descriptions to a fixed width, which lands mid-word
 *  ("…read, manage, and send m"). Trim back to the last whole word so the cut
 *  reads as deliberate. */
const tidyDescription = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  if (/[.!?]$/.test(trimmed)) return trimmed;
  const lastSpace = trimmed.lastIndexOf(" ");
  return `${(lastSpace > 40 ? trimmed.slice(0, lastSpace) : trimmed).replace(/[,;:]$/, "")}…`;
};

type PresetEntry = {
  readonly preset: IntegrationPreset;
  readonly pluginKey: string;
  readonly pluginLabel: string;
};

interface Row {
  readonly key: string;
  readonly testId: string;
  readonly title: string;
  /** Surface kind for product matching (productKey); not rendered. */
  readonly kindKey: string;
  /** The domain, shown beside a prettified title so near-namesakes stay
   *  distinguishable. Omitted when the title is already the domain. */
  readonly domain?: string;
  readonly description?: string;
  readonly iconUrl?: string;
  readonly onSelect: () => void;
  readonly added: boolean;
  /** Namespace of the installed integration this row matched — the View
   *  destination. Known for quick-added rows and for rows whose installed
   *  match came from the catalog list. */
  readonly viewSlug?: string;
  /** Added DURING this picker session (quick add). Excluded from the
   *  added-first float: the card the user just clicked must keep its place —
   *  teleporting it to the top mid-interaction is exactly the jumping this
   *  page keeps having to unlearn. It floats on the next visit. */
  readonly freshlyAdded?: boolean;
  readonly busy: boolean;
  /** A click-time failure, rendered on this card rather than page-top. */
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Infinite scroll
// ---------------------------------------------------------------------------

/** Fires `onVisible` whenever the sentinel scrolls near the viewport. The
 *  rootMargin starts the next page a screen early, so scrolling never visibly
 *  hits the bottom of a still-growing list. */
function LoadMoreSentinel(props: { readonly onVisible: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { onVisible } = props;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) onVisible();
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [onVisible]);
  return <div ref={ref} aria-hidden className="h-px" />;
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

/** Registry logos 404 for plenty of hosts; a broken-image glyph in a list of
 *  brand marks looks like a bug, so failures fall back to a neutral mark. */
function RowIcon(props: { readonly src?: string; readonly alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!props.src || failed) {
    return (
      <span
        aria-hidden
        className="flex size-5 items-center justify-center rounded-sm bg-muted text-[10px] font-medium text-muted-foreground"
      >
        {props.alt.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={props.src}
      alt=""
      width={20}
      height={20}
      // NOT lazy. The console scrolls inside a nested container, and Chrome's
      // lazy loading never brings these into view there — every icon sits
      // pending forever while an eager load of the same URL succeeds instantly.
      // A 20px favicon is not worth deferring anyway.
      onError={() => setFailed(true)}
      className="size-5 object-contain"
    />
  );
}

function ResultCard(props: { readonly row: Row }) {
  const { row } = props;
  return (
    <div
      data-testid={row.testId}
      className="flex min-h-[8.5rem] flex-col gap-2.5 rounded-lg border border-border/60 p-4 transition-colors hover:border-border hover:bg-accent/20"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center">
          <RowIcon {...(row.iconUrl ? { src: row.iconUrl } : {})} alt={row.title} />
        </span>
        {row.added ? (
          // The add happened HERE — the card is the receipt. View jumps to
          // the integration's hub, where authenticating happens.
          row.viewSlug ? (
            <Button asChild variant="outline" size="sm" aria-label={`View ${row.title}`}>
              <Link to="/{-$orgSlug}/integrations/$namespace" params={{ namespace: row.viewSlug }}>
                View
              </Link>
            </Button>
          ) : (
            <span className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Added</span>
          )
        ) : row.busy ? (
          <span className="px-2 py-1.5 text-xs text-muted-foreground">Adding…</span>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={row.onSelect}
            // Every card's button reads "Add", so the visible label alone is
            // useless to a screen reader; the accessible name carries the card.
            aria-label={`Add ${row.title}`}
          >
            Add
          </Button>
        )}
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{row.title}</p>
        {row.domain ? (
          <p className="truncate font-mono text-[11px] text-muted-foreground/70">{row.domain}</p>
        ) : null}
      </div>
      {row.description ? (
        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {row.description}
        </p>
      ) : null}
      {row.error ? (
        <p role="alert" className="text-xs text-destructive">
          {row.error}
        </p>
      ) : null}
    </div>
  );
}

function CardSkeleton(props: { readonly index: number }) {
  const { index } = props;
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 p-4">
      <div className="flex items-start justify-between gap-2">
        <Skeleton className="size-8 rounded-md" />
        <Skeleton className="h-8 w-16 rounded-md" />
      </div>
      <div className="space-y-1.5">
        <Skeleton className="h-3.5" style={{ width: `${40 + ((index * 11) % 30)}%` }} />
        <Skeleton className="h-3" style={{ width: `${55 + ((index * 13) % 30)}%` }} />
      </div>
      <Skeleton className="h-3" style={{ width: `${70 + ((index * 7) % 25)}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick add
// ---------------------------------------------------------------------------

type QuickAddFn = (input: IntegrationQuickAddInput) => Promise<IntegrationQuickAddResult>;

/** Collects each plugin's bound quick-add callback into the page's map.
 *  A component per plugin, not a hook over a list: `useQuickAdd` is a hook,
 *  and mounting one bridge per plugin is how a fixed set of per-plugin hooks
 *  stays rules-of-hooks clean. */
function QuickAddBridge(props: {
  readonly plugin: IntegrationPlugin;
  readonly register: (key: string, fn: QuickAddFn | null) => void;
}) {
  const { plugin, register } = props;
  const fn = plugin.useQuickAdd?.() ?? null;
  useEffect(() => {
    register(plugin.key, fn);
    return () => register(plugin.key, null);
  }, [plugin.key, fn, register]);
  return null;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function IntegrationBrowsePage() {
  useExecutorDocumentTitle("Add an integration");
  const navigate = useNavigate();
  const integrationPlugins = useIntegrationPlugins();
  const doDetect = useAtomSet(detectIntegration, { mode: "promiseExit" });
  const installed = useAtomValue(integrationsOptimisticAtom);

  const [query, setQuery] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Resolve-on-click failures belong on the card that was clicked — a page-top
  // alert for a card three screens down reads as a silent failure.
  const [rowError, setRowError] = useState<{
    readonly key: string;
    readonly message: string;
  } | null>(null);
  const [resolvingDomain, setResolvingDomain] = useState<string | null>(null);
  // One-click adds run per-card and CONCURRENTLY — adding Linear must not
  // lock the Notion card. Keyed by row error-key (`domain|kind`).
  const [quickAddingKeys, setQuickAddingKeys] = useState<ReadonlySet<string>>(new Set());
  // Slugs of integrations added from this page, keyed the same way, so the
  // card can flip to View without waiting for the catalog refetch.
  const [quickAddedSlugs, setQuickAddedSlugs] = useState<ReadonlyMap<string, string>>(new Map());
  const quickAdders = useRef(new Map<string, QuickAddFn>());
  const registerQuickAdd = useCallback((key: string, fn: QuickAddFn | null) => {
    if (fn) quickAdders.current.set(key, fn);
    else quickAdders.current.delete(key);
  }, []);

  const isUrl = looksLikeUrl(query);
  // A URL is a destination, not a filter — but half-typed URLs pass through
  // here on every keystroke ("stripe.co" parses as one), and swapping the
  // grid back to the browse head mid-typing made the whole page jump. Freeze
  // the list on the last real query instead; the detect hint is what changes.
  const lastTextQuery = useRef("");
  if (!isUrl) lastTextQuery.current = query;
  const listQuery = isUrl ? lastTextQuery.current : query;
  const text = listQuery.trim().toLowerCase();

  const availableKinds = useMemo(
    () => availableCatalogKinds(integrationPlugins),
    [integrationPlugins],
  );
  // Nothing to exclude now that the registry is the only source.
  const excludeDomains = useMemo(() => new Set<string>(), []);

  const catalog = useCatalogBrowse({ query: listQuery });
  const catalogEntries = useMemo(
    () => filterCatalogEntries(catalog.entries, { excludeDomains, availableKinds }),
    [catalog.entries, excludeDomains, availableKinds],
  );

  /** What is already connected, as `<slug>:<kind>`.
   *
   *  The slug is the closest thing to an identity available today — it is the
   *  namespace the add flow seeds from a registry surface's `slug` or a
   *  preset's name. Kind is carried alongside it because slugs are NOT unique
   *  per surface: the OpenAPI and MCP presets for Stripe, Neon, Sentry and
   *  Axiom share a name and an id, so both seed the same namespace. Without the
   *  kind, adding one marks the other added — the same false positive the
   *  earlier domain match produced.
   *
   *  This still under-reports: a connection the user renamed on the way in no
   *  longer matches, and reads as not-added. That is deliberate — offering to
   *  add something twice is recoverable, claiming something is connected when
   *  it is not is not. The real fix is recording at add time which row an
   *  integration came from; nothing here can infer it after the fact. */
  const installedKeys = useMemo(() => {
    const rows: readonly Integration[] = AsyncResult.isSuccess(installed) ? installed.value : [];
    return new Set(
      rows.map((row) => `${String(row.slug)}:${KIND_TO_PLUGIN_KEY[row.kind] ?? row.kind}`),
    );
  }, [installed]);

  const isAdded = useCallback(
    (kind: string, ...candidates: readonly (string | undefined)[]): boolean =>
      candidates.some((candidate) => {
        if (!candidate) return false;
        return (
          installedKeys.has(`${candidate}:${kind}`) ||
          installedKeys.has(`${slugifyNamespace(candidate)}:${kind}`)
        );
      }),
    [installedKeys],
  );

  /** The installed integration's own namespace for an added row — the View
   *  button's destination. Same matching rules as `isAdded`. */
  const installedSlugFor = useCallback(
    (kind: string, ...candidates: readonly (string | undefined)[]): string | undefined => {
      for (const candidate of candidates) {
        if (!candidate) continue;
        if (installedKeys.has(`${candidate}:${kind}`)) return candidate;
        const slugified = slugifyNamespace(candidate);
        if (installedKeys.has(`${slugified}:${kind}`)) return slugified;
      }
      return undefined;
    },
    [installedKeys],
  );

  const allPresets = useMemo(() => {
    const entries: PresetEntry[] = [];
    for (const plugin of integrationPlugins) {
      for (const preset of plugin.presets ?? []) {
        entries.push({ preset, pluginKey: plugin.key, pluginLabel: plugin.label });
      }
    }
    return entries;
  }, [integrationPlugins]);

  const handleDetect = useCallback(async () => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    setDetecting(true);
    setError(null);
    // Detection is read-only — it inspects a URL and returns candidates without
    // mutating the catalog, so it invalidates nothing.
    const exit = await doDetect({ payload: { url: trimmed }, reactivityKeys: [] });
    if (Exit.isFailure(exit)) {
      trackEvent("integration_detect_submitted", { success: false });
      setError("Couldn't reach that URL. Check it, or start from scratch below.");
      setDetecting(false);
      return;
    }
    const detected = bestDetection(exit.value);
    if (!detected) {
      trackEvent("integration_detect_submitted", { success: false });
      setError("Couldn't tell what that URL exposes. Start from scratch below.");
      setDetecting(false);
      return;
    }
    trackEvent("integration_detect_submitted", {
      success: true,
      detected_kind: detected.kind,
      confidence: detected.confidence,
    });
    const pluginKey = KIND_TO_PLUGIN_KEY[detected.kind] ?? detected.kind;
    if (!integrationPlugins.some((plugin) => plugin.key === pluginKey)) {
      setError(`That looks like a ${detected.kind} integration, which this server can't add.`);
      setDetecting(false);
      return;
    }
    trackEvent("integration_add_started", { plugin_key: pluginKey, via: "detect" });
    void navigate({
      to: "/{-$orgSlug}/integrations/add/$pluginKey",
      params: { pluginKey },
      search: { url: trimmed, namespace: detected.slug },
    });
  }, [query, doDetect, navigate, integrationPlugins]);

  const goToAdd = useCallback(
    (input: {
      readonly kind: string;
      readonly url: string;
      readonly slug?: string;
      readonly domain: string;
      readonly auth?: CatalogSurface["auth"];
      readonly specOverrides?: CatalogSurface["specOverrides"];
    }) => {
      trackEvent("integration_add_started", {
        plugin_key: input.kind,
        via: "catalog",
        catalog_domain: input.domain,
      });
      void navigate({
        to: "/{-$orgSlug}/integrations/add/$pluginKey",
        params: { pluginKey: input.kind },
        search: {
          url: input.url,
          ...(input.slug ? { namespace: input.slug } : {}),
          ...(input.auth?.header ? { authHeader: input.auth.header } : {}),
          ...(input.auth?.note ? { authNote: input.auth.note } : {}),
          ...(input.auth?.kind ? { authKind: input.auth.kind } : {}),
          ...(input.specOverrides ? { specOverrides: JSON.stringify(input.specOverrides) } : {}),
        },
      });
    },
    [navigate],
  );

  /** One-click add, in place. The registry knew the URL and the auth
   *  indicators, so there is nothing to configure — register directly and
   *  flip the card to View, leaving the user on this page to keep adding.
   *  Returns false when it could not (no quick-add for the kind, probe or
   *  registration failed), and the caller falls back to the configuration
   *  screen, which renders the same failure with full context. */
  const tryQuickAdd = useCallback(
    async (input: {
      readonly kind: CatalogKind;
      readonly url: string;
      readonly title: string;
      readonly domain: string;
      /** The row's identity key — carries the PRODUCT, not just domain|kind:
       *  one domain can offer two products of the same kind (the Google
       *  Photos Library and Picker), and a domain-level key marked both cards
       *  added when either one was. */
      readonly rowKey: string;
      readonly slug?: string;
      readonly auth?: CatalogSurface["auth"];
      readonly specOverrides?: CatalogSurface["specOverrides"];
    }): Promise<boolean> => {
      const fn = quickAdders.current.get(KIND_TO_PLUGIN_KEY[input.kind] ?? input.kind);
      if (!fn) return false;
      const rowKey = input.rowKey;
      setQuickAddingKeys((previous) => new Set(previous).add(rowKey));
      trackEvent("integration_add_started", {
        plugin_key: input.kind,
        via: "catalog",
        catalog_domain: input.domain,
      });
      const result = await fn({
        url: input.url,
        name: input.title,
        ...(input.slug ? { slug: input.slug } : {}),
        ...(input.auth?.header ? { authHeader: input.auth.header } : {}),
        ...(input.auth?.kind ? { authKind: input.auth.kind } : {}),
        ...(input.specOverrides ? { specOverrides: input.specOverrides } : {}),
      });
      setQuickAddingKeys((previous) => {
        const next = new Set(previous);
        next.delete(rowKey);
        return next;
      });
      if (!result.ok) return false;
      setQuickAddedSlugs((previous) => new Map(previous).set(rowKey, result.slug));
      return true;
    },
    [],
  );

  const pickCatalogEntry = useCallback(
    async (
      entry: CatalogSearchEntry,
      kind: CatalogKind,
      title: string,
      rowKey: string,
      knownUrl?: string,
    ) => {
      // The registry already told us where this surface lives — go, rather than
      // spending a round trip re-asking for something we were handed.
      const surface = entry.surfaces?.find((candidate) => candidate.kind === kind);
      if (knownUrl) {
        const added = await tryQuickAdd({
          kind,
          url: knownUrl,
          title,
          domain: entry.domain,
          rowKey,
          ...(surface ? { slug: surface.slug } : {}),
          ...(surface?.auth ? { auth: surface.auth } : {}),
          ...(surface?.specOverrides ? { specOverrides: surface.specOverrides } : {}),
        });
        if (added) return;
        goToAdd({
          kind,
          url: knownUrl,
          domain: entry.domain,
          ...(surface ? { slug: surface.slug } : {}),
          ...(surface?.auth ? { auth: surface.auth } : {}),
          ...(surface?.specOverrides ? { specOverrides: surface.specOverrides } : {}),
        });
        return;
      }
      if (resolvingDomain !== null) return;
      setResolvingDomain(entry.domain);
      setRowError(null);
      const exit = await Effect.runPromiseExit(resolveConnectTarget(entry.domain, [kind]));
      setResolvingDomain(null);
      if (Exit.isFailure(exit) || !exit.value) {
        setRowError({
          key: rowKey,
          message: "Couldn't load connect details. Paste its URL above instead.",
        });
        return;
      }
      const target = exit.value;
      const added = await tryQuickAdd({
        kind: target.kind,
        url: target.url,
        title,
        domain: entry.domain,
        rowKey,
        ...(target.slug ? { slug: target.slug } : {}),
      });
      if (added) return;
      goToAdd({
        kind: target.kind,
        url: target.url,
        domain: entry.domain,
        ...(target.slug ? { slug: target.slug } : {}),
      });
    },
    [goToAdd, resolvingDomain, tryQuickAdd],
  );

  const pickPreset = useCallback(
    (entry: PresetEntry) => {
      trackEvent("integration_add_started", {
        plugin_key: entry.pluginKey,
        via: "preset",
        preset_id: entry.preset.id,
      });
      void navigate({
        to: "/{-$orgSlug}/integrations/add/$pluginKey",
        params: { pluginKey: entry.pluginKey },
        search: { preset: entry.preset.id },
      });
    },
    [navigate],
  );

  // --- Preset rows ---------------------------------------------------------
  //
  // Only presets WITHOUT a connect URL remain cards: a preset with a URL is a
  // registry row's job now, while a local-process server (Chrome DevTools over
  // stdio) has no registry representation yet.
  const presetRows = useMemo<readonly Row[]>(() => {
    const rows: Row[] = [];
    for (const entry of allPresets) {
      if (entry.preset.url !== undefined || entry.preset.endpoint !== undefined) continue;
      if (text.length > 0) {
        const corpus =
          `${entry.preset.name} ${entry.preset.summary ?? ""} ${entry.preset.family ?? ""} ${entry.pluginLabel}`.toLowerCase();
        if (!corpus.includes(text)) continue;
      }
      const surface = SURFACE_WORD[entry.pluginKey] ?? entry.pluginLabel;
      const title = withSurface(entry.preset.name, surface);
      const kindKey = entry.pluginKey === "google" ? "openapi" : entry.pluginKey;
      rows.push({
        key: `preset-${entry.pluginKey}-${entry.preset.id}`,
        testId: `preset-${entry.pluginKey}-${entry.preset.id}`,
        title,
        kindKey,
        ...(entry.preset.summary ? { description: entry.preset.summary } : {}),
        ...(entry.preset.icon ? { iconUrl: entry.preset.icon } : {}),
        onSelect: () => pickPreset(entry),
        // The rendered title is also what the add flow derives the namespace
        // from, so the card recognises an add made through it even when the
        // preset declares no defaultSlug and its bare name would miss.
        added: isAdded(entry.pluginKey, entry.preset.defaultSlug, entry.preset.name, title),
        busy: false,
      });
    }
    return rows;
  }, [allPresets, text, pickPreset, isAdded]);

  // --- Catalog rows: one per (service, surface) -----------------------------
  const catalogRows = useMemo<readonly Row[]>(() => {
    let rows = catalogEntries.flatMap((entry): readonly Row[] => {
      const pretty = entry.name ?? domainDisplayName(entry.domain);
      const description = entry.description ? tidyDescription(entry.description) : undefined;
      // Prefer the registry's own per-surface records, and within them only
      // the surfaces that carry a connect target: the registry can know a
      // surface EXISTS without knowing where it lives (conjur.org's OpenAPI
      // has no recorded spec URL), and a card whose Add can only fail is
      // worse than no card. Kinds-only entries (older registries, stubs) keep
      // the resolve-on-click fallback.
      const surfaces: readonly (CatalogSurface | { readonly kind: CatalogKind })[] =
        entry.surfaces && entry.surfaces.length > 0
          ? entry.surfaces.filter((surface) => surface.url)
          : entry.kinds.map((kind) => ({ kind }));
      return surfaces.map((surface): Row => {
        const known = "slug" in surface ? surface : null;
        const word = SURFACE_WORD[surface.kind] ?? CATALOG_KIND_LABEL[surface.kind];
        const title = withSurface(pretty, word);
        // Product identity, not just domain|kind: two same-kind products can
        // share a domain (Google Photos Library and Picker).
        const rowKey = `${entry.domain}|${surface.kind}|${known?.slug ?? pretty}`;
        const quickAddedSlug = quickAddedSlugs.get(rowKey);
        // Same candidate set as `added`: namespaces come from the registry
        // slug (quick add), the domain, or the display name (classic add
        // pages), depending on how the integration got here.
        const viewSlug =
          quickAddedSlug ?? installedSlugFor(surface.kind, known?.slug, entry.domain, title);
        // Slug in the key: one domain can carry many product surfaces of the
        // same kind (Microsoft Graph's workloads all live on one domain).
        return {
          key: `catalog-${entry.domain}-${surface.kind}-${known?.slug ?? pretty}`,
          testId: `catalog-${known?.slug ?? `${entry.domain}-${surface.kind}`}`,
          title,
          kindKey: surface.kind,
          domain: entry.domain,
          ...(description ? { description } : {}),
          iconUrl:
            (known && "icon" in known ? known.icon : undefined) ?? catalogLogoUrl(entry.domain, 10),
          onSelect: () => void pickCatalogEntry(entry, surface.kind, title, rowKey, known?.url),
          added:
            quickAddedSlug !== undefined || isAdded(surface.kind, known?.slug, entry.domain, title),
          ...(quickAddedSlug !== undefined ? { freshlyAdded: true } : {}),
          ...(viewSlug ? { viewSlug } : {}),
          busy: resolvingDomain === entry.domain || quickAddingKeys.has(rowKey),
          ...(rowError?.key === rowKey ? { error: rowError.message } : {}),
        };
      });
    });
    // A registry row for something a preset already offers is a worse copy of
    // it: same service, no auth template, no health check. Matched on
    // productKey — normalized name plus kind — because neither titles nor
    // domains line up reliably: the Gmail preset's icon is Google's (so a
    // domain comparison let a second "Gmail API" through), and the GitHub
    // preset says "GitHub REST" where the registry row says "GitHub API".
    const presetKeys = new Set(presetRows.map((row) => productKey(row.title, row.kindKey)));
    rows = rows.filter((row) => !presetKeys.has(productKey(row.title, row.kindKey)));
    if (text.length === 0) return rows;
    // A name match beats a mention in the blurb: searching "gmail" should not
    // rank a CRM that merely describes itself as living inside Gmail above
    // Gmail. Stable within each group, so the registry's own order survives.
    const isNamed = (row: Row) => `${row.title} ${row.domain ?? ""}`.toLowerCase().includes(text);
    return [...rows.filter(isNamed), ...rows.filter((row) => !isNamed(row))];
  }, [
    catalogEntries,
    isAdded,
    installedSlugFor,
    quickAddedSlugs,
    quickAddingKeys,
    resolvingDomain,
    pickCatalogEntry,
    text,
    presetRows,
    rowError,
  ]);

  // Local-process cards hold no rank of their own, so each slots in where its
  // title falls alphabetically among the surrounding rows — pinning them to
  // the top of a popularity-ranked list gave Chrome DevTools pride of place
  // over everything. They also WAIT for the catalog: painting a lone Chrome
  // DevTools card while the registry loads reads as a one-item catalog, then
  // reflows. When the registry is unreachable they render anyway, so the page
  // degrades to the cards that still work.
  const results = useMemo(() => {
    if (catalog.loading && catalogRows.length === 0 && !catalog.failed) return catalogRows;
    const merged = [...catalogRows];
    for (const preset of presetRows) {
      const at = merged.findIndex(
        (row) => row.title.localeCompare(preset.title, undefined, { sensitivity: "base" }) > 0,
      );
      merged.splice(at === -1 ? merged.length : at, 0, preset);
    }
    // What you already have leads the list — those cards are the ones with a
    // state worth seeing (View). Stable within each half, and fresh
    // quick-adds hold their place until the next visit.
    const floats = (row: Row) => row.added && row.freshlyAdded !== true;
    // Installed integrations whose registry rows are NOT in the loaded page
    // still belong at the front — "added first" is about the user's catalog,
    // not about which sixty rows the registry ranked highest. Synthesized
    // from the integration record itself; a loaded row that matched an
    // installed integration claims its slug, so nothing appears twice.
    const claimed = new Set(merged.flatMap((row) => (row.viewSlug ? [row.viewSlug] : [])));
    const installedList: readonly Integration[] = AsyncResult.isSuccess(installed)
      ? installed.value
      : [];
    const installedRows: readonly Row[] = installedList
      .filter(
        (row) =>
          row.canRemove &&
          (row.kind === "mcp" || row.kind === "openapi" || row.kind === "graphql") &&
          !claimed.has(String(row.slug)) &&
          (text.length === 0 ||
            row.name.toLowerCase().includes(text) ||
            String(row.slug).includes(text)),
      )
      .map(
        (row): Row => ({
          key: `installed-${String(row.slug)}`,
          testId: `installed-${String(row.slug)}`,
          title: row.name,
          kindKey: row.kind,
          ...(row.description && row.description !== row.name
            ? { description: tidyDescription(row.description) }
            : {}),
          onSelect: () => {},
          added: true,
          viewSlug: String(row.slug),
          busy: false,
        }),
      );
    return [...installedRows, ...merged.filter(floats), ...merged.filter((row) => !floats(row))];
  }, [presetRows, catalogRows, catalog.loading, catalog.failed, installed, text]);

  // Presets are local, so a list that already has them is not empty — show
  // skeletons only when there is genuinely nothing on screen yet.
  const loading = catalog.loading && results.length === 0;

  return (
    <PageContainer>
      {integrationPlugins.map((plugin) => (
        <QuickAddBridge key={plugin.key} plugin={plugin} register={registerQuickAdd} />
      ))}
      <PageHeader
        title="Add an integration"
        description="Search for a service, or point executor at any MCP server, OpenAPI spec, or GraphQL endpoint."
      />

      <div className="mb-4 flex gap-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="text"
            value={query}
            onChange={(event) => {
              setQuery((event.target as HTMLInputElement).value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && isUrl) void handleDetect();
            }}
            placeholder="Search integrations, or paste a URL…"
            aria-label="Search integrations, or paste a URL"
            disabled={detecting}
            // oxlint-disable-next-line jsx_a11y/no-autofocus -- deliberate: searching is the page's only purpose, and it is reached by an explicit "Add integration" action
            autoFocus
            className="h-11 pl-9 text-sm"
          />
        </div>
        {isUrl ? (
          <Button
            className="h-11 shrink-0"
            onClick={() => void handleDetect()}
            disabled={detecting || query.trim().length === 0}
            loading={detecting}
          >
            Add this URL
          </Button>
        ) : null}
      </div>

      {/* Above the results, not below: an endless list has no reachable
          bottom, and this is the escape hatch for exactly the person the
          list is failing. One quiet line; the label carries the action, so
          the chips stay bare format names. */}
      <div className="mb-8 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="shrink-0 text-xs text-muted-foreground">Start from scratch:</span>
        <div className="flex shrink-0 items-center gap-1.5">
          {integrationPlugins.map(
            (plugin: IntegrationPlugin): ReactNode => (
              // oxlint-disable-next-line react/forbid-elements -- a chip, not a Button variant
              <button
                key={plugin.key}
                type="button"
                aria-label={`New ${plugin.label} integration from scratch`}
                onClick={() => {
                  trackEvent("integration_add_started", { plugin_key: plugin.key, via: "manual" });
                  void navigate({
                    to: "/{-$orgSlug}/integrations/add/$pluginKey",
                    params: { pluginKey: plugin.key },
                  });
                }}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <PlusIcon className="size-3" aria-hidden />
                {plugin.label}
              </button>
            ),
          )}
        </div>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          Can&apos;t find it? Paste its URL above.
        </span>
      </div>

      {error ? (
        <p role="alert" className="mb-4 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 9 }).map((_, index) => (
            <CardSkeleton key={index} index={index} />
          ))}
        </div>
      ) : results.length === 0 ? (
        <p className="px-3 py-10 text-center text-sm text-muted-foreground">
          {catalog.failed
            ? "Couldn't load the full list right now. You can still paste the URL of an MCP server, OpenAPI spec, or GraphQL endpoint to add it directly."
            : "Nothing matches that. Paste the URL of an MCP server, OpenAPI spec, or GraphQL endpoint to add it directly."}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {results.map((row) => (
            <ResultCard key={row.key} row={row} />
          ))}
          {catalog.loadingMore
            ? Array.from({ length: 3 }, (_, index) => (
                <CardSkeleton key={`more-${index}`} index={index} />
              ))
            : null}
          {catalog.hasMore ? (
            <div className="col-span-full">
              <LoadMoreSentinel onVisible={catalog.loadMore} />
            </div>
          ) : null}
        </div>
      )}
    </PageContainer>
  );
}
