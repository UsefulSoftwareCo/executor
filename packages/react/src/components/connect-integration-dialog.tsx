import { useCallback, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import { ArrowLeftIcon, SearchIcon } from "lucide-react";
import type { IntegrationDetectionResult } from "@executor-js/sdk/shared";
import { useIntegrationPlugins } from "@executor-js/sdk/client";

import { detectIntegration } from "../api/atoms";
import { trackEvent } from "../api/analytics";
import { Button } from "./button";
import { Badge } from "./badge";
import { Input } from "./input";
import { FilterTabs } from "./filter-tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog";
import { familyLabel } from "../lib/integration-grouping";
import { pluginKeyForIntegrationKind } from "../lib/integration-plugin-keys";
import {
  familyMemberEntries,
  presetCatalogEntries,
  presetCatalogItems,
  presetTypeFacets,
  type PresetEntry,
} from "../lib/preset-catalog";

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

export function ConnectIntegrationDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
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
