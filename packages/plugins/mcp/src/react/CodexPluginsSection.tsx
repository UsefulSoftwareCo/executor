import { useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { Button } from "@executor-js/react/components/button";
import { integrationsOptimisticAtom } from "@executor-js/react/api/atoms";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { addIntegrationErrorMessage } from "@executor-js/react/lib/integration-add";

import { addMcpServer, codexPluginsAtom } from "./atoms";

// ---------------------------------------------------------------------------
// Codex plugins — one-click stdio presets for OpenAI Codex plugins found on
// this machine (Apple Messages, Computer Use, Computer History, plus anything
// else in the plugin cache with a local MCP server). Entries whose binaries
// are missing still render, with the install hint instead of an Add action:
// the integration stays discoverable on a machine without Codex, and nothing
// of OpenAI's ships with executor to make that happen.
// ---------------------------------------------------------------------------

type CodexPluginRow = {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly available: boolean;
  readonly slug: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly setupHint?: string;
};

export function CodexPluginsSection(props: { readonly onComplete: (slug: string) => void }) {
  const pluginsResult = useAtomValue(codexPluginsAtom);
  const integrationsResult = useAtomValue(integrationsOptimisticAtom);
  const doAddServer = useAtomSet(addMcpServer, { mode: "promiseExit" });

  const [addingId, setAddingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  if (!AsyncResult.isSuccess(pluginsResult)) return null;
  const plugins: readonly CodexPluginRow[] = pluginsResult.value.plugins;
  if (plugins.length === 0) return null;

  const existingSlugs = new Set(
    AsyncResult.isSuccess(integrationsResult)
      ? integrationsResult.value.map((integration) => String(integration.slug))
      : [],
  );

  const handleAdd = async (plugin: CodexPluginRow) => {
    setAddingId(plugin.id);
    setErrors((prev) => ({ ...prev, [plugin.id]: "" }));
    const exit = await doAddServer({
      payload: {
        transport: "stdio" as const,
        name: plugin.name,
        slug: plugin.slug,
        description: plugin.summary,
        command: plugin.command,
        args: [...plugin.args],
        ...(plugin.cwd !== undefined ? { cwd: plugin.cwd } : {}),
        ...(plugin.env !== undefined ? { env: { ...plugin.env } } : {}),
      },
      reactivityKeys: integrationWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setErrors((prev) => ({
        ...prev,
        [plugin.id]: addIntegrationErrorMessage(exit, plugin.slug, "Failed to add plugin"),
      }));
      setAddingId(null);
      return;
    }
    props.onComplete(exit.value.slug);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          Codex plugins
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {plugins.filter((plugin) => plugin.available).length}/{plugins.length} available
        </span>
      </div>
      <div className="divide-y divide-border rounded-lg border border-border">
        {plugins.map((plugin) => {
          const added = existingSlugs.has(plugin.slug);
          const error = errors[plugin.id];
          return (
            <div key={plugin.id} className="flex flex-col gap-1 px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{plugin.name}</p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">{plugin.summary}</p>
                </div>
                {added ? (
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    Added
                  </span>
                ) : plugin.available ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleAdd(plugin)}
                    loading={addingId === plugin.id}
                    disabled={addingId !== null}
                    className="shrink-0"
                  >
                    Add
                  </Button>
                ) : (
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    Requires Codex
                  </span>
                )}
              </div>
              {!plugin.available && plugin.setupHint !== undefined && (
                <p className="text-[11px] text-muted-foreground">{plugin.setupHint}</p>
              )}
              {error !== undefined && error.length > 0 && (
                <p className="text-[12px] text-destructive">{error}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
