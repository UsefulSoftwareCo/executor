/* oxlint-disable react/forbid-elements -- plugin component uses raw HTML controls per SDK convention; see @executor-js/plugin-example for the same pattern */
/**
 * @executor-js/plugin-desktop-settings/client
 *
 * A single page mounted at `/plugins/desktop-settings/` that lets the user
 * inspect and configure the Electron sidecar's server connection. Talks to
 * the main process via `window.executor.*` (exposed by
 * `apps/desktop/src/preload`).
 *
 * The plugin is bundled into apps/local's renderer too (because executor
 * web + desktop share the same client bundle pipeline), but the page
 * only registers a nav entry when `window.executor` is present at
 * module-init time — so the web UI doesn't show a non-functional link.
 */

import { useCallback, useEffect, useState } from "react";
import { defineClientPlugin } from "@executor-js/sdk/client";

// ---------------------------------------------------------------------------
// Shape of the values the desktop preload exposes. Kept inline rather than
// imported from @executor-js/plugin-desktop-settings (or a shared package)
// so this client bundle has no runtime dependency on the Electron
// surface — when `window.executor` is undefined (web), the page silently
// no-ops instead of crashing.
// ---------------------------------------------------------------------------

interface DesktopServerSettings {
  readonly port: number;
  readonly requireAuth: boolean;
  readonly password: string;
}

interface DesktopServerConnection {
  readonly kind: "desktop-sidecar";
  readonly key: "desktop-sidecar";
  readonly origin: string;
  readonly apiBaseUrl: string;
  readonly displayName: string;
  readonly auth?: {
    readonly kind: "basic";
    readonly username: string;
    readonly password: string;
  };
}

interface ExecutorBridge {
  readonly getServerConnection: () => Promise<DesktopServerConnection | null>;
  readonly getSettings: () => Promise<DesktopServerSettings>;
  readonly updateSettings: (
    patch: Partial<DesktopServerSettings>,
  ) => Promise<DesktopServerSettings>;
  readonly regeneratePassword: () => Promise<DesktopServerSettings>;
  readonly restartServer: () => Promise<DesktopServerConnection>;
}

const readBridge = (): ExecutorBridge | null => {
  if (typeof window === "undefined") return null;
  const candidate = (window as Window & { readonly executor?: ExecutorBridge }).executor;
  if (
    !candidate ||
    typeof candidate.getSettings !== "function" ||
    typeof candidate.getServerConnection !== "function"
  ) {
    return null;
  }
  return candidate;
};

const inDesktop = readBridge() !== null;

// Normalize an IPC rejection into a user-facing string at this UI boundary.
// The renderer doesn't get typed errors back from Electron's invoke channel.
// We don't pull `err.message` out — the structured error doesn't help the
// user, only "save failed" matters. The main process logs the full error.
const describeIpcError = (_err: unknown): string =>
  "Save failed — check the desktop console for details.";

// ---------------------------------------------------------------------------
// SettingsPage
// ---------------------------------------------------------------------------

function SettingsPage() {
  const bridge = readBridge();
  const [connection, setConnection] = useState<DesktopServerConnection | null>(null);
  const [settings, setSettings] = useState<DesktopServerSettings | null>(null);
  const [draft, setDraft] = useState<DesktopServerSettings | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "restarting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    void Promise.all([bridge.getSettings(), bridge.getServerConnection()]).then(
      ([nextSettings, nextConnection]) => {
        setSettings(nextSettings);
        setDraft(nextSettings);
        setConnection(nextConnection);
      },
    );
  }, [bridge]);

  const restartAndRefreshConnection = useCallback(async () => {
    if (!bridge) return;
    setStatus("restarting");
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: renderer ↔ Electron IPC, errors surface in the form
    try {
      setConnection(await bridge.restartServer());
    } catch (err) {
      setError(describeIpcError(err));
      setStatus("error");
      return;
    }
    setStatus("idle");
  }, [bridge]);

  const apply = useCallback(
    async (patch: Partial<DesktopServerSettings>) => {
      if (!bridge) return;
      setStatus("saving");
      setError(null);
      let next: DesktopServerSettings;
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: renderer ↔ Electron IPC, errors surface in the form
      try {
        next = await bridge.updateSettings(patch);
      } catch (err) {
        setError(describeIpcError(err));
        setStatus("error");
        return;
      }
      setSettings(next);
      setDraft(next);
      await restartAndRefreshConnection();
    },
    [bridge, restartAndRefreshConnection],
  );

  const regenerate = useCallback(async () => {
    if (!bridge) return;
    setStatus("saving");
    let next: DesktopServerSettings;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: renderer ↔ Electron IPC
    try {
      next = await bridge.regeneratePassword();
    } catch (err) {
      setError(describeIpcError(err));
      setStatus("error");
      return;
    }
    setSettings(next);
    setDraft(next);
    await restartAndRefreshConnection();
  }, [bridge, restartAndRefreshConnection]);

  if (!bridge) {
    return (
      <div style={{ maxWidth: 560, margin: "3rem auto", padding: "1.5rem" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Desktop server settings</h1>
        <p style={{ color: "var(--muted-foreground, #888)" }}>
          Open this page from Executor Desktop to inspect and change the active server connection.
        </p>
      </div>
    );
  }

  if (!settings || !draft || !connection) {
    return <div style={{ maxWidth: 560, margin: "3rem auto", padding: "1.5rem" }}>Loading…</div>;
  }

  const dirty =
    draft.port !== settings.port ||
    draft.requireAuth !== settings.requireAuth ||
    draft.password !== settings.password;

  const authLabel =
    connection.auth?.kind === "basic"
      ? `Basic auth as ${connection.auth.username}`
      : "No HTTP auth";
  const cliProfileCommand = `executor server add desktop ${connection.origin} --default`;
  const cliUseCommand =
    connection.auth?.kind === "basic"
      ? `EXECUTOR_AUTH_PASSWORD=${connection.auth.password} executor tools sources --server desktop`
      : "executor tools sources --server desktop";

  return (
    <div style={{ maxWidth: 760, margin: "2rem auto", padding: "1.5rem" }}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 600, marginBottom: "0.25rem" }}>
        Desktop server connection
      </h1>
      <p
        style={{
          fontSize: "0.875rem",
          color: "var(--muted-foreground, #888)",
          marginBottom: "1.5rem",
        }}
      >
        {connection.displayName}
      </p>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
          gap: "0.75rem",
          marginBottom: "1.5rem",
        }}
      >
        <ConnectionField label="Origin" value={connection.origin} />
        <ConnectionField label="API" value={connection.apiBaseUrl} />
        <ConnectionField label="Auth" value={authLabel} />
        <ConnectionField label="Kind" value={connection.kind} />
      </section>

      <section
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          marginBottom: "1.5rem",
          padding: "0.85rem",
          borderRadius: 6,
          border: "1px solid var(--border, #ddd)",
          background: "var(--muted, #f5f5f5)",
        }}
      >
        <div style={{ fontSize: "0.8rem", fontWeight: 600 }}>CLI profile</div>
        <code style={{ overflow: "auto", whiteSpace: "nowrap", fontSize: "0.8rem" }}>
          {cliProfileCommand}
        </code>
        <code style={{ overflow: "auto", whiteSpace: "nowrap", fontSize: "0.8rem" }}>
          {cliUseCommand}
        </code>
      </section>

      <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
          <span style={{ fontSize: "0.875rem", fontWeight: 500 }}>Port</span>
          {/* oxlint-disable-next-line react/forbid-elements -- plugin component uses raw HTML controls per SDK convention */}
          <input
            type="number"
            min={1}
            max={65535}
            value={draft.port}
            onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
            style={{
              padding: "0.5rem 0.7rem",
              borderRadius: 6,
              border: "1px solid var(--border, #ddd)",
              fontFamily: "inherit",
              fontSize: "0.95rem",
              width: "8rem",
            }}
          />
          <span style={{ fontSize: "0.75rem", color: "var(--muted-foreground, #888)" }}>
            Changes restart the connection at <code>http://127.0.0.1:{draft.port}</code>.
          </span>
        </label>

        <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem" }}>
          {/* oxlint-disable-next-line react/forbid-elements -- plugin component uses raw HTML controls per SDK convention */}
          <input
            type="checkbox"
            checked={!draft.requireAuth}
            onChange={(e) => setDraft({ ...draft, requireAuth: !e.target.checked })}
            style={{ marginTop: "0.25rem" }}
          />
          <span style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
            <span style={{ fontSize: "0.875rem", fontWeight: 500 }}>Use without a password</span>
            <span style={{ fontSize: "0.75rem", color: "var(--muted-foreground, #888)" }}>
              Disables HTTP Basic auth on the sidecar. Any process running as you on this machine
              can hit <code>/api</code> directly.
            </span>
          </span>
        </label>

        {draft.requireAuth && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            <span style={{ fontSize: "0.875rem", fontWeight: 500 }}>Password</span>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <code
                style={{
                  flex: 1,
                  padding: "0.5rem 0.7rem",
                  borderRadius: 6,
                  border: "1px solid var(--border, #ddd)",
                  background: "var(--muted, #f5f5f5)",
                  fontSize: "0.85rem",
                  overflow: "auto",
                  whiteSpace: "nowrap",
                }}
              >
                {settings.password}
              </code>
              {/* oxlint-disable-next-line react/forbid-elements -- plugin component uses raw HTML controls per SDK convention */}
              <button
                type="button"
                onClick={() => void regenerate()}
                disabled={status !== "idle"}
                style={{
                  padding: "0.45rem 0.85rem",
                  borderRadius: 6,
                  border: "1px solid var(--border, #ddd)",
                  background: "var(--background, white)",
                  fontFamily: "inherit",
                  fontSize: "0.85rem",
                  cursor: status === "idle" ? "pointer" : "default",
                }}
              >
                Regenerate
              </button>
            </div>
            <span style={{ fontSize: "0.75rem", color: "var(--muted-foreground, #888)" }}>
              Regenerating this changes the active server connection and invalidates existing HTTP
              MCP client configs.
            </span>
          </div>
        )}

        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {/* oxlint-disable-next-line react/forbid-elements -- plugin component uses raw HTML controls per SDK convention */}
          <button
            type="button"
            disabled={!dirty || status !== "idle"}
            onClick={() =>
              void apply({
                port: draft.port,
                requireAuth: draft.requireAuth,
              })
            }
            style={{
              padding: "0.55rem 1.1rem",
              borderRadius: 6,
              border: "1px solid transparent",
              background: dirty ? "var(--primary, #0d0d10)" : "var(--muted, #eee)",
              color: dirty ? "var(--primary-foreground, white)" : "var(--muted-foreground, #888)",
              fontFamily: "inherit",
              fontSize: "0.9rem",
              cursor: dirty && status === "idle" ? "pointer" : "default",
            }}
          >
            {status === "saving"
              ? "Saving…"
              : status === "restarting"
                ? "Restarting server…"
                : "Save"}
          </button>
          {error && (
            <span style={{ fontSize: "0.8rem", color: "var(--destructive, #c00)" }}>{error}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function ConnectionField(props: { readonly label: string; readonly value: string }) {
  return (
    <div
      style={{
        display: "flex",
        minWidth: 0,
        flexDirection: "column",
        gap: "0.2rem",
        padding: "0.75rem",
        borderRadius: 6,
        border: "1px solid var(--border, #ddd)",
      }}
    >
      <span style={{ fontSize: "0.7rem", color: "var(--muted-foreground, #888)" }}>
        {props.label}
      </span>
      <code style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {props.value}
      </code>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugin spec
// ---------------------------------------------------------------------------

export default defineClientPlugin({
  id: "desktop-settings",
  pages: [
    {
      path: "/",
      component: SettingsPage,
      // Only contribute a nav entry when running inside the desktop app.
      // Web users see an empty Sources nav without a non-functional
      // "Settings" link.
      ...(inDesktop ? { nav: { label: "Settings" } } : {}),
    },
  ],
});
