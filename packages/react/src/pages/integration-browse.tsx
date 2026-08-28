import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { CheckIcon, PlusIcon, SearchIcon } from "lucide-react";
import type { Integration, IntegrationDetectionResult } from "@executor-js/sdk/shared";
import {
  useIntegrationPlugins,
  type IntegrationPlugin,
  type IntegrationPreset,
} from "@executor-js/sdk/client";

import { detectIntegration, integrationsOptimisticAtom } from "../api/atoms";
import { slugifyNamespace } from "../plugins/namespace";
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
// TWO SOURCES, ONE LIST. The registry is the bulk of it, but this deployment's
// own presets come first and cannot be dropped for it: production usage says
// the most-added integrations are Gmail, Google Calendar, Drive, Sheets and
// Docs, and the whole Microsoft Graph family (Outlook mail and calendar,
// Teams, OneDrive, SharePoint, OneNote, Excel) — all of them presets. The
// registry has no Outlook, no OneDrive and no OneNote at all, and answers
// "google drive" with file.googleapis.com, which is Filestore. Sourcing from
// it alone silently removed the top of the catalog.
//
// A preset wins over a registry row for the same service: it carries the auth
// template, scopes and health check the bare catalog entry lacks. Neither
// source is named or badged — where a row came from is executor's business.
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
  // Nothing to exclude now that the registry is the only source.
  const excludeDomains = useMemo(() => new Set<string>(), []);

  const catalog = useCatalogBrowse({ query: listQuery, ...(kind ? { kind } : {}) });
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
    }) => {
      trackEvent("integration_add_started", {
        plugin_key: input.kind,
        via: "catalog",
        catalog_domain: input.domain,
      });
      void navigate({
        to: "/{-$orgSlug}/integrations/add/$pluginKey",
        params: { pluginKey: input.kind },
        search: { url: input.url, ...(input.slug ? { namespace: input.slug } : {}) },
      });
    },
    [navigate],
  );

  const pickCatalogEntry = useCallback(
    async (entry: CatalogSearchEntry, kind: CatalogKind, knownUrl?: string) => {
      // The registry already told us where this surface lives — go, rather than
      // spending a round trip re-asking for something we were handed.
      const surface = entry.surfaces?.find((candidate) => candidate.kind === kind);
      if (knownUrl) {
        goToAdd({
          kind,
          url: knownUrl,
          domain: entry.domain,
          ...(surface ? { slug: surface.slug } : {}),
        });
        return;
      }
      if (resolvingDomain !== null) return;
      setResolvingDomain(entry.domain);
      setError(null);
      const exit = await Effect.runPromiseExit(resolveConnectTarget(entry.domain, [kind]));
      setResolvingDomain(null);
      if (Exit.isFailure(exit) || !exit.value) {
        setError(`Couldn't load connect details for ${entry.domain}. Paste its URL above instead.`);
        return;
      }
      const target = exit.value;
      goToAdd({
        kind: target.kind,
        url: target.url,
        domain: entry.domain,
        ...(target.slug ? { slug: target.slug } : {}),
      });
    },
    [goToAdd, resolvingDomain],
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
      const surface = SURFACE_WORD[entry.pluginKey] ?? entry.pluginLabel;
      rows.push({
        key: `preset-${entry.pluginKey}-${entry.preset.id}`,
        testId: `preset-${entry.preset.id}`,
        title: withSurface(entry.preset.name, surface),
        ...(entry.preset.summary ? { description: entry.preset.summary } : {}),
        ...(entry.preset.icon ? { iconUrl: entry.preset.icon } : {}),
        onSelect: () => pickPreset(entry),
        added: isAdded(entry.pluginKey, entry.preset.defaultSlug, entry.preset.name),
        busy: false,
      });
    }
    return rows;
  }, [allPresets, kind, text, pickPreset, isAdded]);

  // --- Catalog rows: one per (service, surface) -----------------------------
  const catalogRows = useMemo<readonly Row[]>(() => {
    let rows = catalogEntries.flatMap((entry): readonly Row[] => {
      const pretty = domainDisplayName(entry.domain);
      const description = entry.description ? tidyDescription(entry.description) : undefined;
      // Prefer the registry's own per-surface records. Without them all we know
      // is which kinds exist, so the connect target has to be resolved on click
      // and there is no identifier to recognise an existing integration by —
      // in which case the row offers Add rather than claiming anything.
      const surfaces: readonly (CatalogSurface | { readonly kind: CatalogKind })[] =
        entry.surfaces && entry.surfaces.length > 0
          ? entry.surfaces
          : entry.kinds.map((kind) => ({ kind }));
      return surfaces.map((surface): Row => {
        const known = "slug" in surface ? surface : null;
        const word = SURFACE_WORD[surface.kind] ?? CATALOG_KIND_LABEL[surface.kind];
        return {
          key: `catalog-${entry.domain}-${surface.kind}`,
          testId: `catalog-${entry.domain}-${surface.kind}`,
          title: withSurface(pretty, word),
          domain: entry.domain,
          ...(description ? { description } : {}),
          iconUrl: catalogLogoUrl(entry.domain, 10),
          onSelect: () => void pickCatalogEntry(entry, surface.kind, known?.url),
          added: isAdded(surface.kind, known?.slug),
          busy: resolvingDomain === entry.domain,
        };
      });
    });
    // A registry row for something a preset already offers is a worse copy of
    // it: same service, no auth template, no health check. Matched on the
    // rendered title because a preset's domain is inferred from its icon and
    // often does not match the registry's (the Gmail preset's icon is Google's,
    // so a domain comparison let a second "Gmail API" through).
    const presetTitles = new Set(presetRows.map((row) => row.title.toLowerCase()));
    rows = rows.filter((row) => !presetTitles.has(row.title.toLowerCase()));
    if (text.length === 0) return rows;
    // A name match beats a mention in the blurb: searching "gmail" should not
    // rank a CRM that merely describes itself as living inside Gmail above
    // Gmail. Stable within each group, so the registry's own order survives.
    const isNamed = (row: Row) => `${row.title} ${row.domain ?? ""}`.toLowerCase().includes(text);
    return [...rows.filter(isNamed), ...rows.filter((row) => !isNamed(row))];
  }, [catalogEntries, isAdded, resolvingDomain, pickCatalogEntry, text, presetRows]);

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
