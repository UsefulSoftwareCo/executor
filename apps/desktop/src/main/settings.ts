import Store from "electron-store";
import { rotateLocalAuthToken } from "./local-auth";
import { DEFAULT_SERVER_SETTINGS, type DesktopServerSettings } from "../shared/server-settings";

interface PersistedShape {
  readonly server: DesktopServerSettings;
  readonly serverProfiles?: string;
}

const store = new Store<PersistedShape>({
  name: "settings",
  ...(process.env.EXECUTOR_DESKTOP_SETTINGS_DIR
    ? { cwd: process.env.EXECUTOR_DESKTOP_SETTINGS_DIR }
    : {}),
  defaults: { server: DEFAULT_SERVER_SETTINGS },
});

// Backfill if an older settings.json predates the server section.
if (!store.has("server")) {
  store.set("server", DEFAULT_SERVER_SETTINGS);
}

export const getServerSettings = (): DesktopServerSettings => ({
  // Read defensively: older settings.json files carried `requireAuth`/`password`
  // fields that no longer exist. Only `port` survives.
  port: store.get("server")?.port ?? DEFAULT_SERVER_SETTINGS.port,
});

export const updateServerSettings = (
  patch: Partial<DesktopServerSettings>,
): DesktopServerSettings => {
  const next: DesktopServerSettings = { port: patch.port ?? getServerSettings().port };
  store.set("server", next);
  return next;
};

/**
 * Rotate the local bearer token (auth.json). The caller must restart the
 * sidecar so it loads the new token and re-inject the webview header. Returns
 * the new token.
 */
export const rotateServerToken = (): string => rotateLocalAuthToken();

export const getServerProfiles = (): string | null => store.get("serverProfiles") ?? null;

export const setServerProfiles = (value: string): void => {
  store.set("serverProfiles", value);
};
