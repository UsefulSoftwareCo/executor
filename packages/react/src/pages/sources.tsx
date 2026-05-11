import { Suspense, useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { PlusIcon } from "lucide-react";
import type { SourceDetectionResult } from "@executor-js/sdk";
import { useSourcePlugins, type SourcePlugin, type SourcePreset } from "@executor-js/sdk/client";
import { detectSource, sourcesOptimisticAtom } from "../api/atoms";
import { useScope } from "../hooks/use-scope";
import { McpInstallCard } from "../components/mcp-install-card";
import { Button } from "../components/button";
import { Badge } from "../components/badge";
import { Input } from "../components/input";
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
  CardStackEntryMedia,
  CardStackEntryTitle,
} from "../components/card-stack";
import { SourceFavicon } from "../components/source-favicon";
import { Skeleton } from "../components/skeleton";

const KIND_TO_PLUGIN_KEY: Record<string, string> = {
  openapi: "openapi",
  mcp: "mcp",
  graphql: "graphql",
  googleDiscovery: "googleDiscovery",
};

const detectionRank: Record<SourceDetectionResult["confidence"], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const bestDetection = (
  results: readonly SourceDetectionResult[],
): SourceDetectionResult | undefined =>
  [...results].sort((a, b) => detectionRank[b.confidence] - detectionRank[a.confidence])[0];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SourcesPage() {
  const scopeId = useScope();
  const sources = useAtomValue(sourcesOptimisticAtom(scopeId));
  const [connectOpen, setConnectOpen] = useState(false);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
              Sources
            </h1>
            <p className="mt-1.5 text-[14px] text-muted-foreground">
              Tool providers available in this workspace.
            </p>
          </div>
          <Button onClick={() => setConnectOpen(true)} size="sm" className="shrink-0 gap-1.5">
            <PlusIcon className="size-4" />
            Connect
          </Button>
        </div>

        <div className="mb-8">
          <McpInstallCard />
        </div>

        <div className="mb-8 border-t border-border/50" />

        {AsyncResult.match(sources, {
          onInitial: () => <SourcesGridSkeleton />,
          onFailure: () => <p className="text-sm text-destructive">Failed to load sources</p>,
          onSuccess: ({ value }) => {
            const connectedSources = (
              value as Array<{
                readonly id: string;
                readonly name: string;
                readonly kind: string;
                readonly url?: string;
                readonly runtime?: boolean;
              }>
            ).filter((source) => !source.runtime);

            if (connectedSources.length === 0) {
              return <EmptySources onConnect={() => setConnectOpen(true)} />;
            }

            return (
              <div className="mb-8 space-y-3">
                <SourceGrid sources={connectedSources} />
              </div>
            );
          },
        })}
      </div>

      <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect dialog — URL detection + manual plugin chooser + presets
// ---------------------------------------------------------------------------

// Heuristic: the input either looks like a URL (auto-detect) or a free-text
// search query (filter the preset list). Anything with a scheme, slash, or
// host-with-TLD is treated as a URL; everything else is search.
const looksLikeUrl = (raw: string): boolean => {
  const v = raw.trim();
  if (v.length === 0) return false;
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(v)) return true;
  if (v.includes("/")) return true;
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?$/i.test(v)) return true;
  return false;
};

function ConnectDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const sourcePlugins = useSourcePlugins();
  const scopeId = useScope();
  const doDetect = useAtomSet(detectSource, { mode: "promiseExit" });
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isUrl = looksLikeUrl(query);
  const presetSearch = isUrl ? "" : query;

  const closeAndReset = useCallback(() => {
    setQuery("");
    setError(null);
    setDetecting(false);
    props.onOpenChange(false);
  }, [props]);

  const handleDetect = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setDetecting(true);
    setError(null);
    const exit = await doDetect({
      params: { scopeId },
      payload: { url: trimmed },
    });
    if (Exit.isFailure(exit)) {
      setError("Detection failed. Try adding a source manually.");
      setDetecting(false);
      return;
    }
    const results = exit.value;
    if (results.length === 0) {
      setError("Could not detect a source type from this URL. Try adding manually.");
      setDetecting(false);
      return;
    }
    const detected = bestDetection(results);
    if (!detected) {
      setError("Could not detect a source type from this URL. Try adding manually.");
      setDetecting(false);
      return;
    }
    const pluginKey = KIND_TO_PLUGIN_KEY[detected.kind];
    if (pluginKey) {
      closeAndReset();
      void navigate({
        to: "/sources/add/$pluginKey",
        params: { pluginKey },
        search: { url: trimmed, namespace: detected.namespace },
      });
    } else {
      setError(`Detected source type "${detected.kind}" but no plugin is available for it.`);
      setDetecting(false);
    }
  }, [query, doDetect, navigate, scopeId, closeAndReset]);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) closeAndReset();
        else props.onOpenChange(open);
      }}
    >
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Connect a source</DialogTitle>
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
                onChange={(e) => {
                  setQuery((e.target as HTMLInputElement).value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && isUrl) void handleDetect();
                }}
                placeholder="Search or paste a URL…"
                disabled={detecting}
                className="flex-1"
              />
              {isUrl && (
                <Button onClick={() => void handleDetect()} disabled={detecting || !query.trim()}>
                  {detecting ? "Detecting..." : "Detect"}
                </Button>
              )}
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-foreground/80">Or add manually</p>
            <div className="flex flex-wrap gap-2">
              {sourcePlugins.map((p) => (
                <Link
                  key={p.key}
                  to="/sources/add/$pluginKey"
                  params={{ pluginKey: p.key }}
                  onClick={closeAndReset}
                  className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                >
                  {p.label}
                </Link>
              ))}
            </div>
          </div>

          <PresetGrid plugins={sourcePlugins} onPick={closeAndReset} searchQuery={presetSearch} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptySources(props: { onConnect: () => void }) {
  return (
    <div className="mb-8 flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-16">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <PlusIcon className="size-5" />
      </div>
      <p className="mb-1 text-[14px] font-medium text-foreground/70">No sources yet</p>
      <p className="mb-5 text-[13px] text-muted-foreground/60">
        Connect a source to start curating tools.
      </p>
      <Button onClick={props.onConnect} size="sm" className="gap-1.5">
        <PlusIcon className="size-4" />
        Connect a source
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preset grid (for inside the Connect dialog)
// ---------------------------------------------------------------------------

type PresetEntry = {
  preset: SourcePreset;
  pluginKey: string;
  pluginLabel: string;
};

function PresetGrid(props: {
  plugins: readonly SourcePlugin[];
  onPick: () => void;
  /** Controlled filter query forwarded from the dialog's unified
   *  search/URL input. Empty string disables filtering. */
  searchQuery?: string;
}) {
  const allPresets = useMemo(() => {
    const entries: PresetEntry[] = [];
    for (const plugin of props.plugins) {
      for (const preset of plugin.presets ?? []) {
        entries.push({
          preset,
          pluginKey: plugin.key,
          pluginLabel: plugin.label,
        });
      }
    }
    return entries;
  }, [props.plugins]);

  const filtered = useMemo(() => {
    const q = (props.searchQuery ?? "").trim().toLowerCase();
    if (q.length === 0) return allPresets;
    return allPresets.filter(({ preset, pluginLabel }) => {
      const corpus = `${preset.name} ${preset.summary ?? ""} ${pluginLabel}`.toLowerCase();
      return corpus.includes(q);
    });
  }, [allPresets, props.searchQuery]);

  if (allPresets.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs font-medium text-foreground/80">Popular sources</p>
      <CardStack className="min-w-0">
        {/* Fixed height keeps the dialog stable as the user filters; the
         *  inner area scrolls when the list overflows and shows an empty
         *  state when no presets match. */}
        <CardStackContent className="h-64 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-4 py-6 text-center">
              <p className="text-sm text-muted-foreground">No matching presets</p>
              <p className="text-xs text-muted-foreground/70">
                Paste a URL above to auto-detect, or pick a source type manually.
              </p>
            </div>
          ) : (
            filtered.map(({ preset, pluginKey, pluginLabel }) => {
              const search: Record<string, string> = { preset: preset.id };
              if (preset.url) search.url = preset.url;
              return (
                <CardStackEntry key={`${pluginKey}-${preset.id}`} asChild>
                  <Link
                    to="/sources/add/$pluginKey"
                    params={{ pluginKey }}
                    search={search}
                    onClick={props.onPick}
                  >
                    <CardStackEntryMedia>
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
                    </CardStackEntryMedia>
                    <CardStackEntryContent>
                      <CardStackEntryTitle>{preset.name}</CardStackEntryTitle>
                      <CardStackEntryDescription>{preset.summary}</CardStackEntryDescription>
                    </CardStackEntryContent>
                    <CardStackEntryActions>
                      <Badge variant="secondary">{pluginLabel}</Badge>
                    </CardStackEntryActions>
                  </Link>
                </CardStackEntry>
              );
            })
          )}
        </CardStackContent>
      </CardStack>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source grid — flat list of connected sources, click-through to detail
// ---------------------------------------------------------------------------

function SourceGrid(props: {
  sources: readonly {
    id: string;
    name: string;
    kind: string;
    url?: string;
    runtime?: boolean;
  }[];
}) {
  const sourcePlugins = useSourcePlugins();
  const pluginByKind = useMemo(() => {
    const out = new Map<string, SourcePlugin>();
    for (const p of sourcePlugins) out.set(p.key, p);
    return out;
  }, [sourcePlugins]);

  return (
    <CardStack searchable>
      <CardStackContent>
        {props.sources.map((s) => {
          const pluginKey = KIND_TO_PLUGIN_KEY[s.kind] ?? s.kind;
          const plugin = pluginByKind.get(pluginKey);
          const SummaryComponent = plugin?.summary;
          return (
            <CardStackEntry key={s.id} asChild searchText={`${s.name} ${s.id} ${s.kind}`}>
              <Link to="/sources/$namespace" params={{ namespace: s.id }}>
                <CardStackEntryMedia>
                  <SourceFavicon sourceId={s.id} url={s.url} size={32} />
                </CardStackEntryMedia>
                <CardStackEntryContent>
                  <CardStackEntryTitle>{s.name}</CardStackEntryTitle>
                  <CardStackEntryDescription>{s.id}</CardStackEntryDescription>
                </CardStackEntryContent>
                <CardStackEntryActions>
                  {SummaryComponent && (
                    <Suspense fallback={null}>
                      <SummaryComponent sourceId={s.id} />
                    </Suspense>
                  )}
                  {s.runtime ? (
                    <Badge className="bg-muted text-muted-foreground">built-in</Badge>
                  ) : (
                    <Badge variant="secondary">{s.kind}</Badge>
                  )}
                </CardStackEntryActions>
              </Link>
            </CardStackEntry>
          );
        })}
      </CardStackContent>
    </CardStack>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function SourcesGridSkeleton() {
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
