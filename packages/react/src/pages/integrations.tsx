import { Suspense, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { ArrowLeftIcon, PlusIcon, SearchIcon } from "lucide-react";
import type { Integration, IntegrationDetectionResult } from "@executor-js/sdk/shared";
import { useIntegrationPlugins, type IntegrationPlugin } from "@executor-js/sdk/client";
import { detectIntegration, integrationsOptimisticAtom } from "../api/atoms";
import { trackEvent } from "../api/analytics";
import { McpInstallCard } from "../components/mcp-install-card";
import { Button } from "../components/button";
import { PageContainer, PageHeader } from "../components/page";
import { Badge } from "../components/badge";
import { Input } from "../components/input";
import { FilterTabs } from "../components/filter-tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
  CardStackHeader,
} from "../components/card-stack";
import {
  IntegrationFavicon,
  integrationInferredUrl,
  integrationPresetIconUrl,
} from "../components/integration-favicon";
import {
  familyLabel,
  groupIntegrations,
  type IntegrationFamilyGroup,
} from "../lib/integration-grouping";
import { IntegrationHealthSummary } from "../components/integration-health-summary";
import { IntegrationIconWithAccount } from "../components/integration-icon-with-account";
import { Skeleton } from "../components/skeleton";
import { useExecutorDocumentTitle } from "../lib/document-title";
import { ErrorState } from "../components/error-state";
import { isAsyncResultLoading } from "../lib/async-result";
import { pluginKeyForIntegrationKind } from "../lib/integration-plugin-keys";
import {
  familyMemberEntries,
  presetCatalogEntries,
  presetCatalogItems,
  presetTypeFacets,
  type PresetEntry,
} from "../lib/preset-catalog";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function IntegrationsPage() {
  useExecutorDocumentTitle("Integrations");
  const integrations = useAtomValue(integrationsOptimisticAtom);
  const refreshIntegrations = useAtomRefresh(integrationsOptimisticAtom);
  const [connectOpen, setConnectOpen] = useState(false);

  return (
    <PageContainer>
      <PageHeader
        title="Integrations"
        description="Tool providers available in this workspace."
        actions={
          <Button
            onClick={() => {
              setConnectOpen(true);
              trackEvent("integration_connect_dialog_opened");
            }}
            size="sm"
            className="gap-1.5"
          >
            <PlusIcon className="size-4" />
            Connect
          </Button>
        }
      />

      <div className="mb-8">
        <McpInstallCard />
      </div>

      <div className="mb-8 border-t border-border/50" />

      {isAsyncResultLoading(integrations) ? (
        <IntegrationsGridSkeleton />
      ) : (
        AsyncResult.match(integrations, {
          onInitial: () => <IntegrationsGridSkeleton />,
          onFailure: () => (
            <ErrorState message="Failed to load integrations" onRetry={refreshIntegrations} />
          ),
          onSuccess: ({ value }) => {
            if (value.length === 0) {
              return (
                <EmptyIntegrations
                  onConnect={() => {
                    setConnectOpen(true);
                    trackEvent("integration_connect_dialog_opened");
                  }}
                />
              );
            }

            return (
              <div className="mb-8 space-y-3">
                <IntegrationGrid integrations={value} />
              </div>
            );
          },
        })
      )}

      <ConnectIntegrationDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </PageContainer>
  );
}

const detectionRank: Record<IntegrationDetectionResult["confidence"], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const bestDetection = (
  results: readonly IntegrationDetectionResult[],
): IntegrationDetectionResult | undefined =>
  [...results].sort((a, b) => detectionRank[b.confidence] - detectionRank[a.confidence])[0];

// Heuristic: the input either looks like a URL (auto-detect) or a free-text
// search query (filter the catalog). Anything with a scheme, slash, or
// host-with-TLD is treated as a URL; everything else is search.
const looksLikeUrl = (raw: string): boolean => {
  const v = raw.trim();
  if (v.length === 0) return false;
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(v)) return true;
  if (v.includes("/")) return true;
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?$/i.test(v)) return true;
  return false;
};

/** The route a preset card links to: the plugin's add flow, pre-filled. */
const presetLinkSearch = (entry: PresetEntry): Record<string, string> => {
  const search: Record<string, string> = { preset: entry.preset.id };
  if (entry.preset.url) search.url = entry.preset.url;
  return search;
};

const PresetIcon = (props: { src?: string; alt?: string; className?: string }) =>
  props.src ? (
    <img
      src={props.src}
      alt={props.alt ?? ""}
      loading="lazy"
      className={props.className ?? "size-6 object-contain"}
    />
  ) : (
    <svg viewBox="0 0 16 16" className={props.className ?? "size-4"} fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );

// ---------------------------------------------------------------------------
// Connect dialog — search/detect, protocol facets, and a browsable catalog
// where multi-service providers collapse into one card you can open.
// ---------------------------------------------------------------------------

function ConnectIntegrationDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const integrationPlugins = useIntegrationPlugins();
  const doDetect = useAtomSet(detectIntegration, { mode: "promiseExit" });
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [pluginFilter, setPluginFilter] = useState("all");
  const [openFamily, setOpenFamily] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isUrl = looksLikeUrl(query);
  const presetSearch = isUrl ? "" : query;

  const entries = useMemo(() => presetCatalogEntries(integrationPlugins), [integrationPlugins]);
  const facets = useMemo(() => presetTypeFacets(entries, presetSearch), [entries, presetSearch]);

  // Browsing groups providers; opening one drills into its services. Searching
  // or switching protocol leaves the drill-down, so a query always searches the
  // whole catalog rather than silently scoping to the open provider.
  const items = useMemo(() => {
    const filter = {
      query: presetSearch,
      pluginKey: pluginFilter === "all" ? null : pluginFilter,
    };
    if (openFamily === null) return presetCatalogItems(entries, filter);
    return familyMemberEntries(entries, openFamily)
      .filter((entry) => filter.pluginKey === null || entry.pluginKey === filter.pluginKey)
      .map((entry) => ({ type: "single", entry }) as const);
  }, [entries, presetSearch, pluginFilter, openFamily]);

  const openFamilyLabel = openFamily === null ? null : familyLabel(openFamily);

  const resultsRef = useRef<HTMLDivElement>(null);
  const scrollResultsToTop = () => resultsRef.current?.scrollTo({ top: 0 });

  const closeAndReset = useCallback(() => {
    setQuery("");
    setPluginFilter("all");
    setOpenFamily(null);
    setError(null);
    setDetecting(false);
    props.onOpenChange(false);
  }, [props]);

  const handleDetect = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setDetecting(true);
    setError(null);
    // Detection is read-only — it inspects a URL and returns candidates without
    // mutating the catalog, so it invalidates nothing.
    const exit = await doDetect({ payload: { url: trimmed }, reactivityKeys: [] });
    if (Exit.isFailure(exit)) {
      trackEvent("integration_detect_submitted", { success: false });
      setError("Detection failed. Try adding an integration manually.");
      setDetecting(false);
      return;
    }
    const detected = exit.value.length === 0 ? undefined : bestDetection(exit.value);
    if (!detected) {
      trackEvent("integration_detect_submitted", { success: false });
      setError("Could not detect an integration type from this URL. Try adding manually.");
      setDetecting(false);
      return;
    }
    trackEvent("integration_detect_submitted", {
      success: true,
      detected_kind: detected.kind,
      confidence: detected.confidence,
    });
    const pluginKey = pluginKeyForIntegrationKind(detected.kind);
    if (integrationPlugins.some((p) => p.key === pluginKey)) {
      trackEvent("integration_add_started", { plugin_key: pluginKey, via: "detect" });
      closeAndReset();
      void navigate({
        to: "/{-$orgSlug}/integrations/add/$pluginKey",
        params: { pluginKey },
        search: { url: trimmed, namespace: detected.slug },
      });
    } else {
      setError(`Detected integration type "${detected.kind}" but no plugin is available for it.`);
      setDetecting(false);
    }
  }, [query, doDetect, navigate, integrationPlugins, closeAndReset]);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) closeAndReset();
        else props.onOpenChange(open);
      }}
    >
      <DialogContent className="flex max-h-[min(46rem,92vh)] flex-col gap-4 sm:max-w-[52rem]">
        <DialogHeader>
          <DialogTitle>Connect an integration</DialogTitle>
          <DialogDescription>Search the library, or paste a URL to auto-detect.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery((e.target as HTMLInputElement).value);
                  setOpenFamily(null);
                  setError(null);
                  scrollResultsToTop();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && isUrl) void handleDetect();
                }}
                placeholder="Search or paste a URL…"
                disabled={detecting}
                className="pl-9"
              />
            </div>
            {isUrl && (
              <Button onClick={() => void handleDetect()} disabled={detecting || !query.trim()}>
                {detecting ? "Detecting..." : "Detect"}
              </Button>
            )}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <FilterTabs
          tabs={facets.map((facet) => ({
            label: facet.label,
            value: facet.key ?? "all",
            count: facet.count,
          }))}
          value={pluginFilter}
          onChange={(value) => {
            setPluginFilter(value);
            setOpenFamily(null);
            scrollResultsToTop();
          }}
        />

        {openFamilyLabel !== null && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 gap-1.5 text-muted-foreground"
              onClick={() => {
                setOpenFamily(null);
                scrollResultsToTop();
              }}
            >
              <ArrowLeftIcon className="size-4" />
              All integrations
            </Button>
            <span className="text-sm font-medium">{openFamilyLabel}</span>
            <span className="text-xs text-muted-foreground">
              {items.length} {items.length === 1 ? "service" : "services"}
            </span>
          </div>
        )}

        <div
          ref={resultsRef}
          className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border"
        >
          {items.length === 0 ? (
            <div className="flex h-full min-h-40 flex-col items-center justify-center gap-1 px-4 py-10 text-center">
              <p className="text-sm text-muted-foreground">No matching integrations</p>
              <p className="text-xs text-muted-foreground/70">
                Paste a URL above to auto-detect, or add one manually below.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2">
              {items.map((item) =>
                item.type === "family" ? (
                  <Button
                    key={`family-${item.family}`}
                    variant="ghost"
                    onClick={() => {
                      setOpenFamily(item.family);
                      scrollResultsToTop();
                      trackEvent("integration_picker_family_opened", { family: item.family });
                    }}
                    className="h-auto justify-start gap-3 rounded-none bg-background px-4 py-3 text-left font-normal hover:bg-muted"
                  >
                    <div className="grid size-8 shrink-0 grid-cols-2 grid-rows-2 gap-0.5">
                      {item.members.slice(0, 4).map((member) => (
                        <PresetIcon
                          key={member.preset.id}
                          src={member.preset.icon}
                          className="size-3.5 self-center justify-self-center object-contain"
                        />
                      ))}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{item.label}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {item.members
                          .slice(0, 3)
                          .map((member) => member.preset.name)
                          .join(", ")}
                        {item.members.length > 3 ? "…" : ""}
                      </p>
                    </div>
                    <Badge variant="secondary" className="shrink-0">
                      {item.members.length} services
                    </Badge>
                  </Button>
                ) : (
                  <Link
                    key={`${item.entry.pluginKey}-${item.entry.preset.id}`}
                    to="/{-$orgSlug}/integrations/add/$pluginKey"
                    params={{ pluginKey: item.entry.pluginKey }}
                    search={presetLinkSearch(item.entry)}
                    onClick={() => {
                      trackEvent("integration_add_started", {
                        plugin_key: item.entry.pluginKey,
                        via: "preset",
                        preset_id: item.entry.preset.id,
                      });
                      closeAndReset();
                    }}
                    className="flex items-center gap-3 bg-background px-4 py-3 transition-colors hover:bg-muted"
                  >
                    <PresetIcon
                      src={item.entry.preset.icon}
                      className="size-6 shrink-0 object-contain"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{item.entry.preset.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {item.entry.preset.summary}
                      </p>
                    </div>
                    <Badge variant="secondary" className="shrink-0">
                      {item.entry.pluginLabel}
                    </Badge>
                  </Link>
                ),
              )}
              {items.length % 2 === 1 && <div className="hidden bg-background sm:block" />}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">Not listed? Add manually:</p>
          {integrationPlugins.map((p) => (
            <Link
              key={p.key}
              to="/{-$orgSlug}/integrations/add/$pluginKey"
              params={{ pluginKey: p.key }}
              onClick={() => {
                trackEvent("integration_add_started", { plugin_key: p.key, via: "manual" });
                closeAndReset();
              }}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted"
            >
              {p.label}
            </Link>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyIntegrations(props: { onConnect: () => void }) {
  return (
    <div className="mb-8 flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-16">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <PlusIcon className="size-5" />
      </div>
      <p className="mb-1 text-[14px] font-medium text-foreground/70">No integrations yet</p>
      <p className="mb-5 text-[13px] text-muted-foreground/60">
        Connect an integration to start curating tools.
      </p>
      <Button onClick={props.onConnect} size="sm" className="gap-1.5">
        <PlusIcon className="size-4" />
        Connect an integration
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Integration grid — flat list of catalog integrations, click-through to detail
// ---------------------------------------------------------------------------

function IntegrationGrid(props: { integrations: readonly Integration[] }) {
  const integrationPlugins = useIntegrationPlugins();
  const pluginByKind = useMemo(() => {
    const out = new Map<string, IntegrationPlugin>();
    for (const p of integrationPlugins) out.set(p.key, p);
    return out;
  }, [integrationPlugins]);

  const items = useMemo(() => groupIntegrations(props.integrations), [props.integrations]);

  const renderEntry = (integration: Integration) => {
    const pluginKey = pluginKeyForIntegrationKind(integration.kind);
    const plugin = pluginByKind.get(pluginKey);
    const SummaryComponent = plugin?.summary;
    const slug = String(integration.slug);
    const name = integration.name || slug;
    return (
      <CardStackEntry key={slug} asChild searchText={`${name} ${slug} ${integration.kind}`}>
        <Link
          to="/{-$orgSlug}/integrations/$namespace"
          params={{ namespace: slug }}
          data-testid={`integration-entry-${slug}`}
        >
          <IntegrationIconWithAccount
            icon={integrationPresetIconUrl(
              { id: slug, kind: integration.kind, name, url: integration.displayUrl },
              integrationPlugins,
            )}
            integrationId={slug}
            url={integration.displayUrl ?? integrationInferredUrl({ id: slug, name }) ?? undefined}
          />
          <CardStackEntryContent>
            <CardStackEntryTitle>{name}</CardStackEntryTitle>
            <CardStackEntryDescription>{slug}</CardStackEntryDescription>
          </CardStackEntryContent>
          <CardStackEntryActions>
            {SummaryComponent && (
              <Suspense fallback={null}>
                <SummaryComponent integrationId={slug} />
              </Suspense>
            )}
            <IntegrationHealthSummary integration={integration.slug} />
          </CardStackEntryActions>
        </Link>
      </CardStackEntry>
    );
  };

  const rendered: ReactNode[] = [];
  let flatRun: Integration[] = [];
  const flushFlat = () => {
    if (flatRun.length === 0) return;
    const run = flatRun;
    flatRun = [];
    rendered.push(
      <CardStack key={`flat-${String(run[0]!.slug)}`} searchable>
        <CardStackContent>{run.map(renderEntry)}</CardStackContent>
      </CardStack>,
    );
  };

  for (const item of items) {
    if (item.type === "single") {
      flatRun.push(item.integration);
      continue;
    }
    flushFlat();
    rendered.push(
      <IntegrationFamilyGroupCard
        key={`group-${item.family}`}
        group={item}
        plugin={pluginByKind.get("openapi")}
        renderEntry={renderEntry}
      />,
    );
  }
  flushFlat();

  return <div className="space-y-3">{rendered}</div>;
}

function IntegrationFamilyGroupCard(props: {
  group: IntegrationFamilyGroup;
  plugin: IntegrationPlugin | undefined;
  renderEntry: (integration: Integration) => ReactNode;
}) {
  const { group, plugin, renderEntry } = props;
  const headerIcon =
    plugin?.presets?.find((preset) => preset.family === group.family && preset.icon)?.icon ?? null;
  return (
    <CardStack collapsible defaultOpen data-testid={`integration-group-${group.family}`}>
      <CardStackHeader>
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center">
            <IntegrationFavicon icon={headerIcon} size={16} />
          </span>
          <span className="truncate">{group.label}</span>
          <span className="shrink-0 font-mono text-xs font-normal text-muted-foreground">
            {group.members.length}
          </span>
        </span>
      </CardStackHeader>
      <CardStackContent>{group.members.map(renderEntry)}</CardStackContent>
    </CardStack>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function IntegrationsGridSkeleton() {
  return (
    <CardStack>
      <CardStackContent>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="size-8 shrink-0 rounded-md" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-4" style={{ width: `${40 + ((i * 11) % 30)}%` }} />
              <Skeleton className="h-3" style={{ width: `${25 + ((i * 7) % 20)}%` }} />
            </div>
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
        ))}
      </CardStackContent>
    </CardStack>
  );
}
