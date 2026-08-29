import { useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { Button } from "@executor-js/react/components/button";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { integrationsOptimisticAtom } from "@executor-js/react/api/atoms";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { addIntegrationErrorMessage } from "@executor-js/react/lib/integration-add";

import { addMcpServer, codexPluginsAtom } from "./atoms";

// ---------------------------------------------------------------------------
// Focused add screen for one Codex plugin, reached from its catalog preset
// (e.g. searching "imessage" in the connect dialog). The preset is only a
// pointer; everything shown here — icon, availability, spawn recipe — comes
// from the server-side scanner reading the user's local Codex install. One
// primary action: Add. No transport toggle, no manual command form.
// ---------------------------------------------------------------------------

export default function CodexPluginAdd(props: {
  readonly presetId: string;
  readonly onComplete: (slug?: string) => void;
  readonly onCancel: () => void;
}) {
  const pluginsResult = useAtomValue(codexPluginsAtom);
  const integrationsResult = useAtomValue(integrationsOptimisticAtom);
  const doAddServer = useAtomSet(addMcpServer, { mode: "promiseExit" });

  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plugin = AsyncResult.isSuccess(pluginsResult)
    ? pluginsResult.value.plugins.find((entry) => entry.id === props.presetId)
    : undefined;

  const added =
    plugin !== undefined &&
    AsyncResult.isSuccess(integrationsResult) &&
    integrationsResult.value.some((integration) => String(integration.slug) === plugin.slug);

  const handleAdd = async () => {
    if (plugin === undefined) return;
    setAdding(true);
    setError(null);
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
      setError(addIntegrationErrorMessage(exit, plugin.slug, "Failed to add plugin"));
      setAdding(false);
      return;
    }
    props.onComplete(exit.value.slug);
  };

  if (!AsyncResult.isSuccess(pluginsResult)) {
    return (
      <div className="flex flex-1 flex-col gap-6">
        <p className="text-[13px] text-muted-foreground">Checking this machine for Codex…</p>
      </div>
    );
  }

  if (plugin === undefined) {
    return (
      <div className="flex flex-1 flex-col gap-6">
        <p className="text-[13px] text-muted-foreground">
          This Codex plugin was not found on this machine.
        </p>
        <FloatActions>
          <Button type="button" variant="ghost" onClick={() => props.onCancel()}>
            Back
          </Button>
        </FloatActions>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-6">
      {/* Mirrors the plugin's own page in Codex: its icon, display name,
          tagline, and long description, all read from the local install. */}
      <div className="flex flex-col gap-4">
        {plugin.icon !== undefined && (
          <img src={plugin.icon} alt="" className="size-16 rounded-2xl" />
        )}
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h1 className="text-xl font-semibold text-foreground">
              {plugin.displayName ?? plugin.name}
            </h1>
            <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              Codex plugin
            </span>
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {plugin.tagline ?? plugin.summary}
          </p>
        </div>
        {plugin.description !== undefined && (
          <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            {plugin.description}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Status
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {added ? "Added" : plugin.available ? "Ready" : "Requires Codex"}
          </span>
        </div>
        {!plugin.available && plugin.setupHint !== undefined && (
          <p className="text-[12px] text-muted-foreground">{plugin.setupHint}</p>
        )}
        {plugin.available && !added && (
          <p className="text-[12px] text-muted-foreground">
            Runs the plugin from your Codex install. Nothing is downloaded.
          </p>
        )}
      </div>

      {error !== null && <p className="text-[12px] text-destructive">{error}</p>}

      <FloatActions>
        <Button type="button" variant="ghost" onClick={() => props.onCancel()} disabled={adding}>
          Cancel
        </Button>
        {added ? (
          <Button type="button" onClick={() => props.onComplete(plugin.slug)}>
            View integration
          </Button>
        ) : (
          <Button
            type="button"
            onClick={() => void handleAdd()}
            disabled={!plugin.available}
            loading={adding}
          >
            Add integration
          </Button>
        )}
      </FloatActions>
    </div>
  );
}
