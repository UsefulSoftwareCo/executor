import { contextBridge, ipcRenderer } from "electron";
import type { DesktopServerConnection, DesktopServerSettings } from "../shared/server-settings";
import {
  type DesktopUpdateStatus,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATUS_CHANNEL,
  UPDATE_STATUS_GET_CHANNEL,
} from "../shared/update";

const api = {
  /** Read the active Executor server connection backing this desktop window. */
  getServerConnection(): Promise<DesktopServerConnection | null> {
    return ipcRenderer.invoke("executor:server:connection");
  },
  /**
   * Read the bearer token for the running sidecar. Only used to build the
   * "Connect an agent" install command, which an external agent runs and so
   * needs the token in plaintext. Returns null when no sidecar is up.
   */
  getServerAuthToken(): Promise<string | null> {
    return ipcRenderer.invoke("executor:server:auth-token");
  },
  /** Read the desktop-persisted server profile payload. */
  getServerProfiles(): Promise<string | null> {
    return ipcRenderer.invoke("executor:server-profiles:get");
  },
  /** Persist the server profile payload in desktop storage. */
  setServerProfiles(value: string): Promise<void> {
    return ipcRenderer.invoke("executor:server-profiles:set", value);
  },
  /** Read the persisted server settings (currently just the port). */
  getSettings(): Promise<DesktopServerSettings> {
    return ipcRenderer.invoke("executor:settings:get");
  },
  /** Patch one or more server settings. Returns the new full settings. */
  updateSettings(patch: Partial<DesktopServerSettings>): Promise<DesktopServerSettings> {
    return ipcRenderer.invoke("executor:settings:update", patch);
  },
  /**
   * Rotate the local bearer token and restart the sidecar so it takes effect.
   * Returns the refreshed connection. AI-client MCP configs must be re-issued
   * with the new token afterwards.
   */
  rotateToken(): Promise<DesktopServerConnection> {
    return ipcRenderer.invoke("executor:server:rotate-token");
  },
  /**
   * Stop + restart the sidecar so settings changes take effect.
   * Main reloads the window and returns the refreshed server connection.
   */
  restartServer(): Promise<DesktopServerConnection> {
    return ipcRenderer.invoke("executor:server:restart");
  },
  /**
   * Open an http(s) URL in the user's default browser. Main-side validates
   * the scheme. Used by the system-browser OAuth flow.
   */
  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke("executor:shell:open-external", url);
  },
  /**
   * Pack logs + crash dumps + a redacted manifest into a zip in Downloads
   * and reveal it in the file manager. Returns the zip path.
   */
  exportDiagnostics(): Promise<string> {
    return ipcRenderer.invoke("executor:diagnostics:export");
  },
  /**
   * Run an interactive update check (menu-flow semantics: native dialogs
   * for "update ready", "no updates", and failures). Used by the crash
   * screen so a broken release can heal itself.
   */
  checkForUpdates(): Promise<void> {
    return ipcRenderer.invoke("executor:updates:check");
  },
  /** Read the current auto-update status once (renderer mount). */
  getUpdateStatus(): Promise<DesktopUpdateStatus> {
    return ipcRenderer.invoke(UPDATE_STATUS_GET_CHANNEL);
  },
  /**
   * Subscribe to auto-update status changes pushed by main (available →
   * downloading → downloaded). Returns an unsubscribe function.
   */
  onUpdateStatus(callback: (status: DesktopUpdateStatus) => void): () => void {
    const listener = (_event: unknown, status: DesktopUpdateStatus) => callback(status);
    ipcRenderer.on(UPDATE_STATUS_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(UPDATE_STATUS_CHANNEL, listener);
    };
  },
  /** Apply a downloaded update and restart the app. */
  installUpdate(): Promise<void> {
    return ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL);
  },
  /**
   * Last-resort recovery for damaged executor state: after a native confirm,
   * back up the data dir (move-aside, never delete), then restart the
   * sidecar fresh. Resolves false when the user cancels the confirm.
   */
  resetState(): Promise<boolean> {
    return ipcRenderer.invoke("executor:state:reset");
  },
  /**
   * Crash-reporting config for the renderer. Null unless this desktop build
   * shipped with a DSN baked in — the shared web UI only initializes its
   * error reporting when this returns a config.
   */
  getCrashReporting(): Promise<{
    readonly dsn: string;
    readonly release: string;
    readonly environment: string;
    readonly runId: string;
  } | null> {
    return ipcRenderer.invoke("executor:crash-reporting:get");
  },
} as const;

contextBridge.exposeInMainWorld("executor", api);

export type ExecutorBridge = typeof api;
