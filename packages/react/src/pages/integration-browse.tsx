import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { getDomain } from "tldts";
import { CheckIcon, PlusIcon, SearchIcon } from "lucide-react";
import type { Integration, IntegrationDetectionResult } from "@executor-js/sdk/shared";
import {
  useIntegrationPlugins,
  type IntegrationPlugin,
  type IntegrationPreset,
} from "@executor-js/sdk/client";

import { detectIntegration, integrationsOptimisticAtom } from "../api/atoms";
import { trackEvent } from "../api/analytics";
import { Button } from "../components/button";
import { Input } from "../components/input";
import { PageContainer, PageHeader } from "../components/page";
import { Skeleton } from "../components/skeleton";
import { cn } from "../lib/utils";
import { useExecutorDocumentTitle } from "../lib/document-title";
import {
  availableCatalogKinds,
  catalogLogoUrl,
  filterCatalogEntries,
  presetDomain,
  presetDomains,
  resolveConnectTarget,
  useCatalogBrowse,
  type CatalogKind,
  type CatalogSearchEntry,
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
// Rows come from two places the reader never learns about: the curated presets
// this deployment ships (which carry auth templates and health checks a bare
// catalog entry does not) sort first, then the rest of the catalog in its own
// popularity order. The catalog is simply where results come from, so it is
// never named, badged, or given a section.
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
  /** The domain, shown beside a prettified title so near-namesakes stay
   *  distinguishable. Omitted when the title is already the domain. */
  readonly domain?: string;
  readonly description?: string;
  readonly iconUrl?: string;
  readonly onSelect: () => void;
  readonly added: boolean;
  readonly busy: boolean;
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
      loading="lazy"
      onError={() => setFailed(true)}
      className="size-5 object-contain"
    />
  );
}

function ResultRow(props: { readonly row: Row }) {
  const { row } = props;
  return (
    <div
      data-testid={row.testId}
      className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/40"
    >
      <span className="flex size-8 shrink-0 items-center justify-center">
        <RowIcon {...(row.iconUrl ? { src: row.iconUrl } : {})} alt={row.title} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">{row.title}</span>
          {row.domain ? (
            <span className="shrink-0 truncate font-mono text-[11px] text-muted-foreground/70">
              {row.domain}
            </span>
          ) : null}
        </span>
        {row.description ? (
          <span className="block truncate text-xs text-muted-foreground">{row.description}</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {row.added ? (
          <span className="flex items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground">
            <CheckIcon className="size-3.5" aria-hidden />
            Added
          </span>
        ) : row.busy ? (
          <span className="px-2 text-xs text-muted-foreground">Adding…</span>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={row.onSelect}
            // Every row's button reads "Add", so the visible label alone is
            // useless to a screen reader; the accessible name carries the row.
            aria-label={`Add ${row.title}`}
          >
            Add
          </Button>
        )}
      </span>
    </div>
  );
}

function RowSkeleton(props: { readonly index: number }) {
  const { index } = props;
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <Skeleton className="size-8 shrink-0 rounded-md" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton className="h-3.5" style={{ width: `${20 + ((index * 11) % 20)}%` }} />
        <Skeleton className="h-3" style={{ width: `${45 + ((index * 13) % 30)}%` }} />
      </div>
      <Skeleton className="h-8 w-16 rounded-md" />
    </div>
  );
}

function KindChip(props: {
  readonly label: string;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  return (
    // oxlint-disable-next-line react/forbid-elements -- a filter chip, not a Button variant
    <button
      type="button"
      onClick={props.onSelect}
      aria-pressed={props.active}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        props.active
          ? "border-foreground/20 bg-foreground text-background"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {props.label}
    </button>
  );
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
  const [kind, setKind] = useState<CatalogKind | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolvingDomain, setResolvingDomain] = useState<string | null>(null);

  const isUrl = looksLikeUrl(query);
  // A URL is a destination, not a filter: stop narrowing the lists so the
  // detect action is the only thing the input is offering.
  const listQuery = isUrl ? "" : query;
  const text = listQuery.trim().toLowerCase();

  const availableKinds = useMemo(
    () => availableCatalogKinds(integrationPlugins),
    [integrationPlugins],
  );
  const excludeDomains = useMemo(() => presetDomains(integrationPlugins), [integrationPlugins]);

  const catalog = useCatalogBrowse({ query: listQuery, ...(kind ? { kind } : {}) });
  const catalogEntries = useMemo(
    () => filterCatalogEntries(catalog.entries, { excludeDomains, availableKinds }),
    [catalog.entries, excludeDomains, availableKinds],
  );

  /** What is already connected, keyed `<domain>:<kind>`.
   *
   *  Domain ALONE is not the identity of a row. Rows are per surface now, so
   *  "Stripe API" and "Stripe MCP" share a domain while being two different
   *  integrations — matching on domain marked both Added the moment either one
   *  was. The kind is what separates them.
   *
   *  A saved integration's `kind` is the wire kind, which the shared map turns
   *  back into the plugin key a row carries. */
  const installedKeys = useMemo(() => {
    const rows: readonly Integration[] = AsyncResult.isSuccess(installed) ? installed.value : [];
    const keys = new Set<string>();
    for (const row of rows) {
      if (!row.displayUrl) continue;
      const domain = getDomain(row.displayUrl);
      if (!domain) continue;
      keys.add(`${domain}:${KIND_TO_PLUGIN_KEY[row.kind] ?? row.kind}`);
    }
    return keys;
  }, [installed]);

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

  const pickCatalogEntry = useCallback(
    async (entry: CatalogSearchEntry, kinds: readonly CatalogKind[]) => {
      if (resolvingDomain !== null) return;
      setResolvingDomain(entry.domain);
      setError(null);
      const exit = await Effect.runPromiseExit(resolveConnectTarget(entry.domain, kinds));
      setResolvingDomain(null);
      if (Exit.isFailure(exit) || !exit.value) {
        setError(`Couldn't load connect details for ${entry.domain}. Paste its URL above instead.`);
        return;
      }
      const target = exit.value;
      trackEvent("integration_add_started", {
        plugin_key: target.kind,
        via: "catalog",
        catalog_domain: entry.domain,
      });
      void navigate({
        to: "/{-$orgSlug}/integrations/add/$pluginKey",
        params: { pluginKey: target.kind },
        search: { url: target.url, ...(target.slug ? { namespace: target.slug } : {}) },
      });
    },
    [navigate, resolvingDomain],
  );

  const pickPreset = useCallback(
    (entry: PresetEntry) => {
      trackEvent("integration_add_started", {
        plugin_key: entry.pluginKey,
        via: "preset",
        preset_id: entry.preset.id,
      });
      const search: Record<string, string> = { preset: entry.preset.id };
      if (entry.preset.url) search.url = entry.preset.url;
      void navigate({
        to: "/{-$orgSlug}/integrations/add/$pluginKey",
        params: { pluginKey: entry.pluginKey },
        search,
      });
    },
    [navigate],
  );

  // --- Preset rows ---------------------------------------------------------
  const presetRows = useMemo<readonly Row[]>(() => {
    const rows: Row[] = [];
    for (const entry of allPresets) {
      if (kind !== null && entry.pluginKey !== kind) continue;
      if (text.length > 0) {
        const corpus =
          `${entry.preset.name} ${entry.preset.summary ?? ""} ${entry.preset.family ?? ""} ${entry.pluginLabel}`.toLowerCase();
        if (!corpus.includes(text)) continue;
      }
      const domain = presetDomain(entry.preset);
      const surface = SURFACE_WORD[entry.pluginKey] ?? entry.pluginLabel;
      rows.push({
        key: `preset-${entry.pluginKey}-${entry.preset.id}`,
        testId: `preset-${entry.preset.id}`,
        title: withSurface(entry.preset.name, surface),
        ...(entry.preset.summary ? { description: entry.preset.summary } : {}),
        ...(entry.preset.icon ? { iconUrl: entry.preset.icon } : {}),
        onSelect: () => pickPreset(entry),
        added: domain !== null && installedKeys.has(`${domain}:${entry.pluginKey}`),
        busy: false,
      });
    }
    return rows;
  }, [allPresets, kind, text, pickPreset, installedKeys]);

  // --- Catalog rows: one per (service, surface) -----------------------------
  const catalogRows = useMemo<readonly Row[]>(() => {
    const rows = catalogEntries.flatMap((entry): readonly Row[] => {
      const pretty = domainDisplayName(entry.domain);
      const description = entry.description ? tidyDescription(entry.description) : undefined;
      return entry.kinds.map((entryKind): Row => {
        const surface = SURFACE_WORD[entryKind] ?? CATALOG_KIND_LABEL[entryKind];
        return {
          key: `catalog-${entry.domain}-${entryKind}`,
          testId: `catalog-${entry.domain}-${entryKind}`,
          title: withSurface(pretty, surface),
          domain: entry.domain,
          ...(description ? { description } : {}),
          iconUrl: catalogLogoUrl(entry.domain, 10),
          onSelect: () => void pickCatalogEntry(entry, [entryKind]),
          added: installedKeys.has(`${entry.domain}:${entryKind}`),
          busy: resolvingDomain === entry.domain,
        };
      });
    });
    if (text.length === 0) return rows;
    // A name match beats a mention in the blurb: searching "gmail" should not
    // rank a CRM that merely describes itself as living inside Gmail above
    // Gmail. Stable within each group, so the registry's own order survives.
    const isNamed = (row: Row) => `${row.title} ${row.domain ?? ""}`.toLowerCase().includes(text);
    return [...rows.filter(isNamed), ...rows.filter((row) => !isNamed(row))];
  }, [catalogEntries, installedKeys, resolvingDomain, pickCatalogEntry, text]);

  const results = useMemo(() => [...presetRows, ...catalogRows], [presetRows, catalogRows]);

  // Presets are local, so a list that already has them is not empty — show
  // skeletons only when there is genuinely nothing on screen yet.
  const loading = catalog.loading && results.length === 0;

  return (
    <PageContainer>
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

      <div className="mb-8 flex flex-wrap items-center gap-1.5">
        <KindChip label="All" active={kind === null} onSelect={() => setKind(null)} />
        {availableKinds.map((candidate) => (
          <KindChip
            key={candidate}
            label={CATALOG_KIND_LABEL[candidate]}
            active={kind === candidate}
            onSelect={() => setKind(candidate)}
          />
        ))}
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
        <div className="flex flex-col gap-1">
          {Array.from({ length: 8 }).map((_, index) => (
            <RowSkeleton key={index} index={index} />
          ))}
        </div>
      ) : results.length === 0 ? (
        <p className="px-3 py-10 text-center text-sm text-muted-foreground">
          {catalog.failed
            ? "Couldn't load the full list right now. You can still paste the URL of an MCP server, OpenAPI spec, or GraphQL endpoint to add it directly."
            : "Nothing matches that. Paste the URL of an MCP server, OpenAPI spec, or GraphQL endpoint to add it directly."}
        </p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {results.map((row) => (
            <ResultRow key={row.key} row={row} />
          ))}
        </div>
      )}

      <section className="mt-8 border-t border-border/50 pt-6">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Start from scratch
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          For a spec you will paste in by hand rather than fetch from a URL.
        </p>
        <div className="flex flex-wrap gap-2">
          {integrationPlugins.map(
            (plugin: IntegrationPlugin): ReactNode => (
              // oxlint-disable-next-line react/forbid-elements -- a chip, not a Button variant
              <button
                key={plugin.key}
                type="button"
                onClick={() => {
                  trackEvent("integration_add_started", { plugin_key: plugin.key, via: "manual" });
                  void navigate({
                    to: "/{-$orgSlug}/integrations/add/$pluginKey",
                    params: { pluginKey: plugin.key },
                  });
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
              >
                <PlusIcon className="size-3.5" aria-hidden />
                {/* Names the ACTION, not just the format: the kind facets above
                  carry the same bare format words, and two controls reading
                  "OpenAPI" on one page is a coin flip. */}
                New {plugin.label} integration
              </button>
            ),
          )}
        </div>
      </section>
    </PageContainer>
  );
}
