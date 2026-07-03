import { Suspense, useCallback, useMemo, useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { PlusIcon } from "lucide-react";
import type { Integration, IntegrationDetectionResult } from "@executor-js/sdk/shared";
import {
  useIntegrationPlugins,
  type IntegrationPlugin,
  type IntegrationPresetCatalogEntry,
} from "@executor-js/sdk/client";
import {
  detectIntegration,
  integrationPresetsAtom,
  integrationsOptimisticAtom,
} from "../api/atoms";
import { trackEvent } from "../api/analytics";
import { McpInstallCard } from "../components/mcp-install-card";
import { Button } from "../components/button";
import { PageContainer, PageHeader } from "../components/page";
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
  googleDiscovery: "google",
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

type IntegrationAddHrefInput = {
  pluginKey: string;
  url?: string;
  preset?: string;
  namespace?: string;
  name?: string;
  description?: string;
};

const integrationDetailHref = (basePath: string, namespace: string): string =>
  `${basePath}/integrations/${encodeURIComponent(namespace)}`;

const integrationAddHref = (basePath: string, input: IntegrationAddHrefInput): string => {
  const params = new URLSearchParams();
  if (input.url) params.set("url", input.url);
  if (input.preset) params.set("preset", input.preset);
  if (input.namespace) params.set("namespace", input.namespace);
  if (input.name) params.set("name", input.name);
  if (input.description) params.set("description", input.description);
  const query = params.toString();
  const href = `${basePath}/integrations/add/${encodeURIComponent(input.pluginKey)}`;
  return query.length === 0 ? href : `${href}?${query}`;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function IntegrationsPage(props: { basePath: string }) {
  const integrations = useAtomValue(integrationsOptimisticAtom);
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

      {AsyncResult.match(integrations, {
        onInitial: () => <IntegrationsGridSkeleton />,
        onFailure: () => <p className="text-sm text-destructive">Failed to load integrations</p>,
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
              <IntegrationGrid basePath={props.basePath} integrations={value} />
            </div>
          );
        },
      })}

      <ConnectDialog
        basePath={props.basePath}
        open={connectOpen}
        onOpenChange={setConnectOpen}
      />
    </PageContainer>
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

function ConnectDialog(props: {
  basePath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const integrationPlugins = useIntegrationPlugins();
  const integrationPresets = useAtomValue(integrationPresetsAtom);
  const doDetect = useAtomSet(detectIntegration, { mode: "promiseExit" });

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
      trackEvent("integration_detect_submitted", { success: false });
      setError("Detection failed. Try adding an integration manually.");
      setDetecting(false);
      return;
    }
    const results = exit.value;
    if (results.length === 0) {
      trackEvent("integration_detect_submitted", { success: false });
      setError("Could not detect an integration type from this URL. Try adding manually.");
      setDetecting(false);
      return;
    }
    const detected = bestDetection(results);
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
    const pluginKey = KIND_TO_PLUGIN_KEY[detected.kind] ?? detected.kind;
    if (integrationPlugins.some((p) => p.key === pluginKey)) {
      trackEvent("integration_add_started", { plugin_key: pluginKey, via: "detect" });
      closeAndReset();
      window.location.assign(
        integrationAddHref(props.basePath, {
          pluginKey,
          url: trimmed,
          namespace: detected.slug,
        }),
      );
    } else {
      setError(`Detected integration type "${detected.kind}" but no plugin is available for it.`);
      setDetecting(false);
    }
  }, [query, doDetect, integrationPlugins, closeAndReset, props.basePath]);

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
                <a
                  key={p.key}
                  href={integrationAddHref(props.basePath, { pluginKey: p.key })}
                  onClick={() => {
                    trackEvent("integration_add_started", { plugin_key: p.key, via: "manual" });
                    closeAndReset();
                  }}
                  className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                >
                  {p.label}
                </a>
              ))}
            </div>
          </div>

          <PresetGrid
            basePath={props.basePath}
            plugins={integrationPlugins}
            presets={integrationPresets}
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
  preset: IntegrationPresetCatalogEntry;
  pluginKey: string;
  pluginLabel: string;
};

function PresetGrid(props: {
  basePath: string;
  plugins: readonly IntegrationPlugin[];
  presets: AsyncResult.AsyncResult<readonly IntegrationPresetCatalogEntry[], unknown>;
  onPick: () => void;
  /** Controlled filter query forwarded from the dialog's unified
   *  search/URL input. Empty string disables filtering. */
  searchQuery?: string;
}) {
  const allPresets = useMemo(() => {
    if (!AsyncResult.isSuccess(props.presets)) return [];
    const pluginByKey = new Map(props.plugins.map((plugin) => [plugin.key, plugin] as const));
    const entries: PresetEntry[] = [];
    for (const preset of props.presets.value) {
      const pluginKey = KIND_TO_PLUGIN_KEY[preset.pluginId] ?? preset.pluginId;
      const plugin = pluginByKey.get(pluginKey);
      if (!plugin) continue;
      entries.push({
        preset,
        pluginKey,
        pluginLabel: plugin.label,
      });
    }
    return entries;
  }, [props.plugins, props.presets]);

  const filtered = useMemo(() => {
    const q = (props.searchQuery ?? "").trim().toLowerCase();
    if (q.length === 0) return allPresets;
    return allPresets.filter(({ preset, pluginLabel }) => {
      const corpus = `${preset.name} ${preset.summary ?? ""} ${pluginLabel}`.toLowerCase();
      return corpus.includes(q);
    });
  }, [allPresets, props.searchQuery]);

  if (!AsyncResult.isSuccess(props.presets)) {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-xs font-medium text-foreground/80">Popular integrations</p>
        <CardStack className="min-w-0">
          <CardStackContent className="h-64 overflow-y-auto">
            <div className="flex h-full flex-col items-center justify-center gap-1 px-4 py-6 text-center">
              <p className="text-sm text-muted-foreground">Loading catalog</p>
            </div>
          </CardStackContent>
        </CardStack>
      </div>
    );
  }

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
              const href = integrationAddHref(props.basePath, {
                pluginKey,
                preset: preset.id,
                namespace: preset.namespace ?? preset.id,
                name: preset.name,
                description: preset.summary,
                ...(preset.url ? { url: preset.url } : {}),
              });
              return (
                <CardStackEntry key={`${pluginKey}-${preset.id}`} asChild>
                  <a
                    href={href}
                    onClick={() => {
                      trackEvent("integration_add_started", {
                        plugin_key: pluginKey,
                        via: "preset",
                        preset_id: preset.id,
                      });
                      props.onPick();
                    }}
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
                  </a>
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

function IntegrationGrid(props: { basePath: string; integrations: readonly Integration[] }) {
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
          const name = integration.name || slug;
          return (
            <CardStackEntry key={slug} asChild searchText={`${name} ${slug} ${integration.kind}`}>
              <a href={integrationDetailHref(props.basePath, slug)}>
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
              </a>
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
