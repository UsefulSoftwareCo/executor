import { Suspense, useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { PlusIcon } from "lucide-react";
import type { Integration, IntegrationDetectionResult } from "@executor-js/sdk/shared";
import {
  useIntegrationPlugins,
  type IntegrationPlugin,
  type IntegrationPreset,
} from "@executor-js/sdk/client";
import { detectIntegration, integrationsOptimisticAtom } from "../api/atoms";
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
import {
  integrationInferredUrl,
  integrationPresetIconUrl,
} from "../components/integration-favicon";
import { IntegrationIconWithAccount } from "../components/integration-icon-with-account";
import { Skeleton } from "../components/skeleton";

const KIND_TO_PLUGIN_KEY: Record<string, string> = {
  openapi: "openapi",
  mcp: "mcp",
  graphql: "graphql",
  googleDiscovery: "openapi",
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function IntegrationsPage() {
  const integrations = useAtomValue(integrationsOptimisticAtom);
  const [connectOpen, setConnectOpen] = useState(false);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
              Integrations
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

        {AsyncResult.match(integrations, {
          onInitial: () => <IntegrationsGridSkeleton />,
          onFailure: () => <p className="text-sm text-destructive">Failed to load integrations</p>,
          onSuccess: ({ value }) => {
            if (value.length === 0) {
              return <EmptyIntegrations onConnect={() => setConnectOpen(true)} />;
            }

            return (
              <div className="mb-8 space-y-3">
                <IntegrationGrid integrations={value} />
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
  const integrationPlugins = useIntegrationPlugins();
  const doDetect = useAtomSet(detectIntegration, { mode: "promiseExit" });
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
    // Detection is read-only — it inspects a URL and returns candidates without
    // mutating the catalog, so it invalidates nothing.
    const exit = await doDetect({
      payload: { url: trimmed },
      reactivityKeys: [],
    });
    if (Exit.isFailure(exit)) {
      setError("Detection failed. Try adding an integration manually.");
      setDetecting(false);
      return;
    }
    const results = exit.value;
    if (results.length === 0) {
      setError("Could not detect an integration type from this URL. Try adding manually.");
      setDetecting(false);
      return;
    }
    const detected = bestDetection(results);
    if (!detected) {
      setError("Could not detect an integration type from this URL. Try adding manually.");
      setDetecting(false);
      return;
    }
    const pluginKey = KIND_TO_PLUGIN_KEY[detected.kind] ?? detected.kind;
    if (integrationPlugins.some((p) => p.key === pluginKey)) {
      closeAndReset();
      void navigate({
        to: "/integrations/add/$pluginKey",
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
              {integrationPlugins.map((p) => (
                <Link
                  key={p.key}
                  to="/integrations/add/$pluginKey"
                  params={{ pluginKey: p.key }}
                  onClick={closeAndReset}
                  className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                >
                  {p.label}
                </Link>
              ))}
            </div>
          </div>

          <PresetGrid
            plugins={integrationPlugins}
            onPick={closeAndReset}
            searchQuery={presetSearch}
          />
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
// Preset grid (for inside the Connect dialog)
// ---------------------------------------------------------------------------

type PresetEntry = {
  preset: IntegrationPreset;
  pluginKey: string;
  pluginLabel: string;
};

function PresetGrid(props: {
  plugins: readonly IntegrationPlugin[];
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
      <p className="text-xs font-medium text-foreground/80">Popular integrations</p>
      <CardStack className="min-w-0">
        {/* Fixed height keeps the dialog stable as the user filters; the
         *  inner area scrolls when the list overflows and shows an empty
         *  state when no presets match. */}
        <CardStackContent className="h-64 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-4 py-6 text-center">
              <p className="text-sm text-muted-foreground">No matching presets</p>
              <p className="text-xs text-muted-foreground/70">
                Paste a URL above to auto-detect, or pick an integration type manually.
              </p>
            </div>
          ) : (
            filtered.map(({ preset, pluginKey, pluginLabel }) => {
              const search: Record<string, string> = { preset: preset.id };
              if (preset.url) search.url = preset.url;
              return (
                <CardStackEntry key={`${pluginKey}-${preset.id}`} asChild>
                  <Link
                    to="/integrations/add/$pluginKey"
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
// Integration grid — flat list of catalog integrations, click-through to detail
// ---------------------------------------------------------------------------

function IntegrationGrid(props: { integrations: readonly Integration[] }) {
  const integrationPlugins = useIntegrationPlugins();
  const pluginByKind = useMemo(() => {
    const out = new Map<string, IntegrationPlugin>();
    for (const p of integrationPlugins) out.set(p.key, p);
    return out;
  }, [integrationPlugins]);

  return (
    <CardStack searchable>
      <CardStackContent>
        {props.integrations.map((integration) => {
          const pluginKey = KIND_TO_PLUGIN_KEY[integration.kind] ?? integration.kind;
          const plugin = pluginByKind.get(pluginKey);
          const SummaryComponent = plugin?.summary;
          const slug = String(integration.slug);
          const name = integration.description || slug;
          return (
            <CardStackEntry key={slug} asChild searchText={`${name} ${slug} ${integration.kind}`}>
              <Link to="/integrations/$namespace" params={{ namespace: slug }}>
                <IntegrationIconWithAccount
                  icon={integrationPresetIconUrl(
                    { id: slug, kind: integration.kind, name, url: integration.displayUrl },
                    integrationPlugins,
                  )}
                  sourceId={slug}
                  url={
                    integration.displayUrl ??
                    integrationInferredUrl({ id: slug, name }) ??
                    undefined
                  }
                />
                <CardStackEntryContent>
                  <CardStackEntryTitle>{name}</CardStackEntryTitle>
                  <CardStackEntryDescription>{slug}</CardStackEntryDescription>
                </CardStackEntryContent>
                <CardStackEntryActions>
                  {SummaryComponent && (
                    <Suspense fallback={null}>
                      <SummaryComponent sourceId={slug} />
                    </Suspense>
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
