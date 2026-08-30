import { useEffect, useRef, useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { Button } from "@executor-js/react/components/button";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { integrationsOptimisticAtom } from "@executor-js/react/api/atoms";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { addIntegrationErrorMessage } from "@executor-js/react/lib/integration-add";

import { addMcpServer, checkCodexPluginAccess, codexPluginsAtom } from "./atoms";
import { CODEX_PERMISSIONS } from "../sdk/codex-permissions";

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
  const doCheckAccess = useAtomSet(checkCodexPluginAccess, { mode: "promiseExit" });

  const [adding, setAdding] = useState(false);
  const [access, setAccess] = useState<{ status: string; message?: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plugin = AsyncResult.isSuccess(pluginsResult)
    ? pluginsResult.value.plugins.find((entry) => entry.id === props.presetId)
    : undefined;

  const permissions = CODEX_PERMISSIONS[props.presetId] ?? [];

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
        // As STATIC env, not `env`: these are machine-derived paths the
        // scanner already resolved, so they must not become credentials the
        // person is asked to type. Sent this way the integration declares no
        // auth, and its connection is created for them.
        ...(plugin.env !== undefined ? { staticEnv: { ...plugin.env } } : {}),
        ...(plugin.appServer !== undefined ? { appServer: { ...plugin.appServer } } : {}),
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

  // Checked on open rather than on a button, so the card states where you
  // stand before you commit to anything. It runs the plugin's read-only probe
  // once per card: macOS offers no way to READ another app's privacy
  // decisions, so trying it is the only way to know.
  const checkedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!plugin?.available) return;
    if (checkedFor.current === props.presetId) return;
    checkedFor.current = props.presetId;
    void handleCheck();
    // `handleCheck` is stable for a given preset; re-running on its identity
    // would re-probe on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin?.available, props.presetId]);

  const handleCheck = async () => {
    setChecking(true);
    setAccess(null);
    // Runs the plugin's own read-only probe down the real path. When macOS has
    // not asked yet, THIS is what makes it ask — so the check doubles as the
    // grant flow.
    // Reads nothing and writes nothing, so no cache is invalidated by it.
    const exit = await doCheckAccess({ params: { id: props.presetId }, reactivityKeys: [] });
    setAccess(
      Exit.isSuccess(exit)
        ? (exit.value as { status: string; message?: string })
        : { status: "blocked", message: "Could not reach the plugin." },
    );
    setChecking(false);
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
        {/* The plugin's own icon comes from the local Codex install; without
            one the card still identifies its provider rather than showing a
            gap, which matters most on the machines that have no install. */}
        <img
          src={plugin.icon ?? plugin.fallbackIcon ?? "https://integrations.sh/logo/openai.com"}
          alt=""
          className="size-16 rounded-2xl"
        />
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
            {added ? "Added" : plugin.available ? "Ready" : "Not installed on this Mac"}
          </span>
        </div>
        {!plugin.available && plugin.setupHint !== undefined && (
          // The hint arrives as numbered lines; render them as the list they
          // are, so the reader sees an ordered path rather than a paragraph.
          <ol className="mt-1 flex list-none flex-col gap-1.5">
            {plugin.setupHint.split("\n").map((step) => (
              <li key={step} className="text-[12px] leading-relaxed text-muted-foreground">
                {step}
              </li>
            ))}
          </ol>
        )}
        {plugin.available && !added && (
          <p className="text-[12px] text-muted-foreground">
            Runs the plugin from your Codex install. Nothing is downloaded.
          </p>
        )}
      </div>

      {/* Stated up front, not discovered on first failure: macOS asks for
          these ONCE, and a dismissed prompt never returns — after that the
          plugin fails with an error the user cannot act on. Each row links
          straight to the pane that holds the switch. */}
      {permissions.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5">
          <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            macOS access
          </span>
          <p className="text-[12px] text-muted-foreground">
            macOS asks the first time this runs. If you miss the prompt, it will not ask again —
            enable it here.
          </p>
          <div className="flex items-center gap-3">
            <span
              className={
                access !== null && access.status !== "ok"
                  ? "text-[12px] text-destructive"
                  : "text-[12px] text-muted-foreground"
              }
            >
              {checking
                ? "Checking…"
                : access === null
                  ? ""
                  : access.status === "ok"
                    ? "Allowed — macOS is letting this through."
                    : (access.message ?? "Blocked.")}
            </span>
            {access !== null && access.status !== "ok" && !checking && (
              <Button type="button" variant="secondary" onClick={() => void handleCheck()}>
                Check again
              </Button>
            )}
          </div>
          <ul className="flex flex-col gap-1.5">
            {permissions.map((permission) => (
              <li key={permission.id} className="flex items-baseline justify-between gap-3">
                <span className="text-[12px] text-muted-foreground">
                  <span className="text-foreground">{permission.label}</span> — {permission.why}
                </span>
                <a
                  href={permission.settingsUrl}
                  className="shrink-0 font-mono text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Open settings
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error !== null && <p className="text-[12px] text-destructive">{error}</p>}

      <FloatActions>
        <Button type="button" variant="ghost" onClick={() => props.onCancel()} disabled={adding}>
          Cancel
        </Button>
        {added ? (
          <Button type="button" onClick={() => props.onComplete(plugin.slug)}>
            View integration
          </Button>
        ) : plugin.available ? (
          <Button type="button" onClick={() => void handleAdd()} loading={adding}>
            Add integration
          </Button>
        ) : (
          <Button asChild>
            <a
              href={plugin.setupUrl ?? "https://openai.com/codex"}
              target="_blank"
              rel="noreferrer"
            >
              Install Codex
            </a>
          </Button>
        )}
      </FloatActions>
    </div>
  );
}
