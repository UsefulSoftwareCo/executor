import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { PlusIcon } from "lucide-react";
import { trackEvent } from "../api/analytics";
import type { Integration } from "@executor-js/sdk/shared";
import { IntegrationFavicon, integrationPresetIconUrl } from "./integration-favicon";
import { integrationsOptimisticAtom } from "../api/atoms";
import { useIntegrationPlugins } from "@executor-js/sdk/client";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "./command";

// ---------------------------------------------------------------------------
// CommandPalette — global ⌘K navigator.
//
// Order of entries:
//   1. Connected sources (priority, shown first)
//   2. Add <Plugin> actions for each available source plugin
//   3. Popular integrations (plugin presets)
// ---------------------------------------------------------------------------

export function CommandPalette() {
  const integrationPlugins = useIntegrationPlugins();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const integrationsResult = useAtomValue(integrationsOptimisticAtom);

  // Toggle with ⌘K / Ctrl+K
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const connectedSources = useMemo(
    () =>
      AsyncResult.match(integrationsResult, {
        onInitial: () => [] as Array<{ id: string; name: string; kind: string; url?: string }>,
        onFailure: () => [] as Array<{ id: string; name: string; kind: string; url?: string }>,
        onSuccess: ({ value }) =>
          value.map((integration: Integration) => ({
            id: String(integration.slug),
            name: integration.name || String(integration.slug),
            kind: integration.kind,
            url: integration.displayUrl,
          })),
      }),
    [integrationsResult],
  );

  const presetEntries = useMemo(() => {
    const entries: Array<{
      pluginKey: string;
      pluginLabel: string;
      presetId: string;
      presetName: string;
      presetSummary?: string;
      presetUrl?: string;
      presetIcon?: string;
    }> = [];
    for (const plugin of integrationPlugins) {
      for (const preset of plugin.presets ?? []) {
        entries.push({
          pluginKey: plugin.key,
          pluginLabel: plugin.label,
          presetId: preset.id,
          presetName: preset.name,
          presetSummary: preset.summary,
          presetUrl: preset.url,
          presetIcon: preset.icon,
        });
      }
    }
    return entries;
  }, [integrationPlugins]);

  const close = useCallback(() => setOpen(false), []);

  const goToIntegration = useCallback(
    (id: string) => {
      close();
      trackEvent("command_palette_navigated", { kind: "integration", plugin_key: id });
      void navigate({ to: "/integrations/$namespace", params: { namespace: id } });
    },
    [close, navigate],
  );

  const goToAdd = useCallback(
    (pluginKey: string) => {
      close();
      trackEvent("command_palette_navigated", { kind: "add_integration", plugin_key: pluginKey });
      trackEvent("integration_add_started", { plugin_key: pluginKey, via: "command_palette" });
      void navigate({
        to: "/integrations/add/$pluginKey",
        params: { pluginKey },
      });
    },
    [close, navigate],
  );

  const goToPreset = useCallback(
    (pluginKey: string, presetId: string, presetUrl?: string) => {
      close();
      trackEvent("command_palette_navigated", { kind: "preset", plugin_key: pluginKey });
      trackEvent("integration_add_started", {
        plugin_key: pluginKey,
        via: "command_palette",
        preset_id: presetId,
      });
      const search: Record<string, string> = { preset: presetId };
      if (presetUrl) search.url = presetUrl;
      void navigate({
        to: "/integrations/add/$pluginKey",
        params: { pluginKey },
        search,
      });
    },
    [close, navigate],
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search integrations or jump to add…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {connectedSources.length > 0 && (
          <CommandGroup heading="Connected">
            {connectedSources.map(
              (s: {
                readonly id: string;
                readonly name: string;
                readonly kind: string;
                readonly url?: string;
              }) => (
                <CommandItem
                  key={`source-${s.id}`}
                  value={`connected ${s.name} ${s.id} ${s.kind}`}
                  onSelect={() => goToIntegration(s.id)}
                >
                  <IntegrationFavicon
                    icon={integrationPresetIconUrl(s, integrationPlugins)}
                    url={s.url}
                  />
                  <span className="flex-1 truncate">{s.name}</span>
                  <CommandShortcut>{s.kind}</CommandShortcut>
                </CommandItem>
              ),
            )}
          </CommandGroup>
        )}

        {connectedSources.length > 0 && integrationPlugins.length > 0 && <CommandSeparator />}

        {integrationPlugins.length > 0 && (
          <CommandGroup heading="Add integration">
            {integrationPlugins.map((plugin) => (
              <CommandItem
                key={`add-${plugin.key}`}
                value={`add ${plugin.label} ${plugin.key}`}
                onSelect={() => goToAdd(plugin.key)}
              >
                <PlusIcon />
                <span className="flex-1 truncate">Add {plugin.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {presetEntries.length > 0 && <CommandSeparator />}

        {presetEntries.length > 0 && (
          <CommandGroup heading="Popular integrations">
            {presetEntries.map((e) => (
              <CommandItem
                key={`preset-${e.pluginKey}-${e.presetId}`}
                value={`preset ${e.presetName} ${e.presetSummary ?? ""} ${e.pluginLabel}`}
                onSelect={() => goToPreset(e.pluginKey, e.presetId, e.presetUrl)}
              >
                {e.presetIcon ? (
                  <img
                    src={e.presetIcon}
                    alt=""
                    className="size-4 shrink-0 object-contain"
                    loading="lazy"
                  />
                ) : (
                  <span aria-hidden className="size-4 shrink-0 rounded-sm bg-muted-foreground/20" />
                )}
                <span className="flex-1 truncate">{e.presetName}</span>
                <CommandShortcut>{e.pluginLabel}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
