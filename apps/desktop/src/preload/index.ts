import { contextBridge, ipcRenderer } from "electron";
import type { DesktopServerConnection, DesktopServerSettings } from "../shared/server-settings";

const api = {
  /** Read the active Executor server connection backing this desktop window. */
  getServerConnection(): Promise<DesktopServerConnection | null> {
    return ipcRenderer.invoke("executor:server:connection");
  },
  /** Read the desktop-persisted server profile payload. */
  getServerProfiles(): Promise<string | null> {
    return ipcRenderer.invoke("executor:server-profiles:get");
  },
  /** Persist the server profile payload in desktop storage. */
  setServerProfiles(value: string): Promise<void> {
    return ipcRenderer.invoke("executor:server-profiles:set", value);
  },
  /** Read the persisted server settings (port, requireAuth, password). */
  getSettings(): Promise<DesktopServerSettings> {
    return ipcRenderer.invoke("executor:settings:get");
  },
  /** Patch one or more server settings. Returns the new full settings. */
  updateSettings(patch: Partial<DesktopServerSettings>): Promise<DesktopServerSettings> {
    return ipcRenderer.invoke("executor:settings:update", patch);
  },
  /** Regenerate the random Basic-auth password. Returns the new settings. */
  regeneratePassword(): Promise<DesktopServerSettings> {
    return ipcRenderer.invoke("executor:settings:regenerate-password");
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
} as const;

contextBridge.exposeInMainWorld("executor", api);

export type ExecutorBridge = typeof api;
