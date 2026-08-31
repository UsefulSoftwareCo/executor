// Reproduction of the ConnectDialog in packages/react/src/pages/integrations.tsx.
//
// Faithful to the parts that shape the experience: one input that silently
// switches between URL-detect and preset-filter, plugin chips above the list,
// a fixed 16rem scroll window over ~30 curated presets in plugin order, and
// the integrations.sh long tail that only appears once you have typed two
// characters. Picking anything leaves the dialog for a full-page form.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@executor-js/react/components/button";
import { Input } from "@executor-js/react/components/input";
import { Badge } from "@executor-js/react/components/badge";
import { Skeleton } from "@executor-js/react/components/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@executor-js/react/components/dialog";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
} from "@executor-js/react/components/card-stack";
import {
  catalogLogoUrl,
  curatedPresets,
  integrationPlugins,
  searchCatalog,
  type CatalogEntry,
  type DemoPreset,
  type PluginKey,
} from "../fixtures";

const CATALOG_KIND_LABEL: Record<string, string> = {
  mcp: "MCP",
  openapi: "OpenAPI",
  graphql: "GraphQL",
};

const looksLikeUrl = (raw: string): boolean => {
  const v = raw.trim();
  if (v.length === 0) return false;
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(v)) return true;
  if (v.includes("/")) return true;
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?$/i.test(v)) return true;
  return false;
};

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

function useCatalogSearch(rawQuery: string) {
  const query = rawQuery.trim().toLowerCase();
  const [state, setState] = useState<{
    readonly entries: readonly CatalogEntry[];
    readonly loading: boolean;
  }>({ entries: [], loading: false });
  const generation = useRef(0);

  useEffect(() => {
    const requestId = ++generation.current;
    if (query.length < MIN_QUERY_LENGTH) {
      setState({ entries: [], loading: false });
      return;
    }
    setState((previous) => ({ ...previous, loading: true }));
    const timer = setTimeout(() => {
      void searchCatalog(query).then((entries) => {
        if (generation.current !== requestId) return;
        setState({ entries, loading: false });
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  return state;
}

export function ConnectDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPickPreset: (preset: DemoPreset) => void;
  readonly onPickPlugin: (pluginKey: PluginKey) => void;
  readonly onPickCatalogEntry: (entry: CatalogEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const isUrl = looksLikeUrl(query);
  const presetSearch = isUrl ? "" : query;

  const filtered = useMemo(() => {
    const q = presetSearch.trim().toLowerCase();
    if (q.length === 0) return curatedPresets;
    return curatedPresets.filter(({ name, summary, pluginLabel }) =>
      `${name} ${summary} ${pluginLabel}`.toLowerCase().includes(q),
    );
  }, [presetSearch]);

  const catalog = useCatalogSearch(presetSearch);
  const showCatalogSection =
    presetSearch.trim().length > 0 && (catalog.entries.length > 0 || catalog.loading);

  const close = () => {
    setQuery("");
    props.onOpenChange(false);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open: boolean) => {
        if (!open) close();
        else props.onOpenChange(open);
      }}
    >
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Connect an integration</DialogTitle>
          <DialogDescription>
            Search the preset library, or paste a URL to auto-detect.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <Input
                type="text"
                value={query}
                onChange={(event) => setQuery((event.target as HTMLInputElement).value)}
                placeholder="Search or paste a URL…"
                className="flex-1"
              />
              {isUrl && <Button disabled={query.trim().length === 0}>Detect</Button>}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-foreground/80">Or add manually</p>
            <div className="flex flex-wrap gap-2">
              {integrationPlugins.map((plugin) => (
                // oxlint-disable-next-line react/forbid-elements
                <button
                  key={plugin.key}
                  type="button"
                  onClick={() => {
                    close();
                    props.onPickPlugin(plugin.key);
                  }}
                  className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                >
                  {plugin.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-xs font-medium text-foreground/80">Popular integrations</p>
            <CardStack className="min-w-0">
              <CardStackContent className="h-64 overflow-y-auto">
                {filtered.length === 0 && !showCatalogSection ? (
                  <div className="flex h-full flex-col items-center justify-center gap-1 px-4 py-6 text-center">
                    <p className="text-sm text-muted-foreground">No matching integrations</p>
                    <p className="text-xs text-muted-foreground/70">
                      Paste a URL above to auto-detect, or pick an integration type manually.
                    </p>
                  </div>
                ) : (
                  filtered.map((preset) => (
                    <CardStackEntry key={`${preset.pluginKey}-${preset.id}`} asChild>
                      {/* oxlint-disable-next-line react/forbid-elements */}
                      <button
                        type="button"
                        className="w-full text-left"
                        onClick={() => {
                          close();
                          props.onPickPreset(preset);
                        }}
                      >
                        <span className="flex size-8 shrink-0 items-center justify-center">
                          {preset.icon ? (
                            <img
                              src={preset.icon}
                              alt=""
                              className="size-5 object-contain"
                              loading="lazy"
                            />
                          ) : (
                            <svg viewBox="0 0 16 16" className="size-3.5" fill="none">
                              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
                            </svg>
                          )}
                        </span>
                        <CardStackEntryContent>
                          <CardStackEntryTitle>{preset.name}</CardStackEntryTitle>
                          <CardStackEntryDescription>{preset.summary}</CardStackEntryDescription>
                        </CardStackEntryContent>
                        <CardStackEntryActions>
                          <Badge variant="secondary">{preset.pluginLabel}</Badge>
                        </CardStackEntryActions>
                      </button>
                    </CardStackEntry>
                  ))
                )}

                {showCatalogSection && (
                  <>
                    {catalog.entries.map((entry) => (
                      <CardStackEntry key={`catalog-${entry.domain}`} asChild>
                        {/* oxlint-disable-next-line react/forbid-elements */}
                        <button
                          type="button"
                          className="w-full text-left"
                          onClick={() => {
                            close();
                            props.onPickCatalogEntry(entry);
                          }}
                        >
                          <span className="flex size-8 shrink-0 items-center justify-center">
                            <img
                              src={catalogLogoUrl(entry.domain, 10)}
                              alt=""
                              className="size-5 object-contain"
                              loading="lazy"
                            />
                          </span>
                          <CardStackEntryContent>
                            <CardStackEntryTitle>{entry.domain}</CardStackEntryTitle>
                            <CardStackEntryDescription>
                              {entry.description}
                            </CardStackEntryDescription>
                          </CardStackEntryContent>
                          <CardStackEntryActions>
                            {entry.kinds.map((kind) => (
                              <Badge key={kind} variant="secondary">
                                {CATALOG_KIND_LABEL[kind]}
                              </Badge>
                            ))}
                          </CardStackEntryActions>
                        </button>
                      </CardStackEntry>
                    ))}
                    {catalog.loading &&
                      catalog.entries.length === 0 &&
                      Array.from({ length: 3 }).map((_, i) => (
                        <div
                          key={`catalog-skeleton-${i}`}
                          className="flex items-center gap-3 px-4 py-3"
                        >
                          <Skeleton className="size-5 shrink-0 rounded-md" />
                          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                            <Skeleton
                              className="h-3.5"
                              style={{ width: `${35 + ((i * 13) % 25)}%` }}
                            />
                            <Skeleton
                              className="h-3"
                              style={{ width: `${55 + ((i * 9) % 20)}%` }}
                            />
                          </div>
                          <Skeleton className="h-5 w-14 rounded-full" />
                        </div>
                      ))}
                  </>
                )}
              </CardStackContent>
            </CardStack>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
