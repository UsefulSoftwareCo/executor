import { randomBytes } from "node:crypto";
import Store from "electron-store";
import { DEFAULT_SERVER_SETTINGS, type DesktopServerSettings } from "../shared/server-settings";

interface PersistedShape {
  readonly server: DesktopServerSettings;
  readonly serverProfiles?: string;
}

const generatePassword = (): string => randomBytes(24).toString("base64url");

const seedDefaults = (): DesktopServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  password: generatePassword(),
});

const store = new Store<PersistedShape>({
  name: "settings",
  defaults: { server: seedDefaults() },
});

// Backfill if an older settings.json predates the server section.
if (!store.has("server")) {
  store.set("server", seedDefaults());
}

export const getServerSettings = (): DesktopServerSettings => store.get("server");

export const updateServerSettings = (
  patch: Partial<DesktopServerSettings>,
): DesktopServerSettings => {
  const current = getServerSettings();
  const next: DesktopServerSettings = {
    port: patch.port ?? current.port,
    requireAuth: patch.requireAuth ?? current.requireAuth,
    password: patch.password ?? current.password,
  };
  store.set("server", next);
  return next;
};

export const regeneratePassword = (): DesktopServerSettings => {
  const next = { ...getServerSettings(), password: generatePassword() };
  store.set("server", next);
  return next;
};

export const getServerProfiles = (): string | null => store.get("serverProfiles") ?? null;

export const setServerProfiles = (value: string): void => {
  store.set("serverProfiles", value);
};
