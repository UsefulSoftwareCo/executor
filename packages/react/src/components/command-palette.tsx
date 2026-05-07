import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { PlusIcon } from "lucide-react";
import { SourceFavicon } from "./source-favicon";
import { sourcesOptimisticAtom } from "../api/atoms";
import { useNavTargets } from "../api/nav-targets";
import { useScope } from "../hooks/use-scope";
import { useSourcePlugins } from "@executor-js/sdk/client";
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
//   3. Popular sources (plugin presets)
// ---------------------------------------------------------------------------

export function CommandPalette() {
  const sourcePlugins = useSourcePlugins();
  const [open, setOpen] = useState(false);
  const { goToSource, goToAddSource } = useNavTargets();
  const scopeId = useScope();
  const sourcesResult = useAtomValue(sourcesOptimisticAtom(scopeId));

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
      AsyncResult.match(sourcesResult, {
        onInitial: () =>
          [] as Array<{
            id: string;
            name: string;
            kind: string;
            url?: string;
            runtime?: boolean;
          }>,
        onFailure: () =>
          [] as Array<{
            id: string;
            name: string;
            kind: string;
            url?: string;
            runtime?: boolean;
          }>,
        onSuccess: ({ value }) => value.filter((s: { readonly runtime?: boolean }) => !s.runtime),
      }),
    [sourcesResult],
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
    for (const plugin of sourcePlugins) {
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
  }, [sourcePlugins]);

  const close = useCallback(() => setOpen(false), []);

  const handleGoToSource = useCallback(
    (id: string) => {
      close();
      goToSource(id);
    },
    [close, goToSource],
  );

  const goToAdd = useCallback(
    (pluginKey: string) => {
      close();
      goToAddSource(pluginKey);
    },
    [close, goToAddSource],
  );

  const goToPreset = useCallback(
    (pluginKey: string, presetId: string, presetUrl?: string) => {
      close();
      goToAddSource(pluginKey, { preset: presetId, url: presetUrl });
    },
    [close, goToAddSource],
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search sources or jump to add…" />
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
                  onSelect={() => handleGoToSource(s.id)}
                >
                  <SourceFavicon url={s.url} />
                  <span className="flex-1 truncate">{s.name}</span>
                  <CommandShortcut>{s.kind}</CommandShortcut>
                </CommandItem>
              ),
            )}
          </CommandGroup>
        )}

        {connectedSources.length > 0 && sourcePlugins.length > 0 && <CommandSeparator />}

        {sourcePlugins.length > 0 && (
          <CommandGroup heading="Add source">
            {sourcePlugins.map((plugin) => (
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
          <CommandGroup heading="Popular sources">
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
