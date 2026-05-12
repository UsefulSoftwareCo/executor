import { contextBridge, ipcRenderer } from "electron";
import type { DesktopServerSettings } from "../shared/server-settings";

const api = {
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
   * Renderer should reload its location after this resolves to point at
   * the (possibly new) port.
   */
  restartServer(): Promise<{ readonly port: number; readonly baseUrl: string }> {
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
