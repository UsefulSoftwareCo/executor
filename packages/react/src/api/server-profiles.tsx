import { Option, Schema } from "effect";
import {
  normalizeExecutorServerConnection,
  type ExecutorServerConnection,
  type ExecutorServerConnectionInput,
} from "./server-connection";

export const EXECUTOR_SERVER_PROFILES_STORAGE_KEY = "executor.serverConnections.v1";

export interface ExecutorServerProfilesSnapshot {
  readonly activeKey: string | null;
  readonly profiles: readonly ExecutorServerConnection[];
}

export interface ExecutorServerProfileStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

const PersistedBasicAuth = Schema.Struct({
  kind: Schema.Literal("basic"),
  username: Schema.optional(Schema.String),
  password: Schema.String,
});

const PersistedBearerAuth = Schema.Struct({
  kind: Schema.Literal("bearer"),
  token: Schema.String,
});

const PersistedAuth = Schema.Union([PersistedBasicAuth, PersistedBearerAuth]);

const PersistedConnection = Schema.Struct({
  kind: Schema.optional(Schema.Literals(["http", "desktop-sidecar"])),
  key: Schema.optional(Schema.String),
  origin: Schema.optional(Schema.String),
  apiBaseUrl: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  auth: Schema.optional(PersistedAuth),
});

const PersistedProfiles = Schema.Struct({
  version: Schema.Literal(1),
  activeKey: Schema.optional(Schema.NullOr(Schema.String)),
  profiles: Schema.Array(PersistedConnection),
});

const decodeProfilesJson = Schema.decodeUnknownOption(Schema.fromJsonString(PersistedProfiles));

const EMPTY_PROFILES: ExecutorServerProfilesSnapshot = {
  activeKey: null,
  profiles: [],
};

const hasHttpScheme = (value: string): boolean => /^https?:\/\//.test(value.trim());

const canParseOrigin = (origin: string | undefined): boolean => {
  if (origin === undefined) return true;
  const trimmed = origin.trim();
  if (!trimmed) return true;
  return URL.canParse(hasHttpScheme(trimmed) ? trimmed : `http://${trimmed}`);
};

const canParseApiBaseUrl = (apiBaseUrl: string | undefined): boolean => {
  if (apiBaseUrl === undefined) return true;
  const trimmed = apiBaseUrl.trim();
  if (!trimmed) return true;
  return hasHttpScheme(trimmed) && URL.canParse(trimmed);
};

const normalizeConnectionOption = (
  input: ExecutorServerConnectionInput,
): ExecutorServerConnection | null => {
  if (!canParseOrigin(input.origin) || !canParseApiBaseUrl(input.apiBaseUrl)) return null;
  return normalizeExecutorServerConnection(input);
};

const asConnectionInput = (
  connection: ExecutorServerConnection,
): ExecutorServerConnectionInput => ({
  kind: connection.kind,
  key: connection.key,
  origin: connection.origin,
  apiBaseUrl: connection.apiBaseUrl,
  displayName: connection.displayName,
  ...(connection.auth ? { auth: connection.auth } : {}),
});

export const parseExecutorServerProfilesSnapshot = (
  raw: string | null | undefined,
): ExecutorServerProfilesSnapshot => {
  if (!raw) return EMPTY_PROFILES;
  const decoded = decodeProfilesJson(raw);
  if (Option.isNone(decoded)) return EMPTY_PROFILES;
  return normalizeExecutorServerProfilesSnapshot(decoded.value);
};

export const serializeExecutorServerProfilesSnapshot = (
  snapshot: ExecutorServerProfilesSnapshot,
): string => {
  // Custom server auth is intentionally persisted with the profile so local-dev
  // and advanced remote endpoints do not force reauth on every reload. Desktop
  // stores this payload through its Electron store; web falls back to
  // localStorage for the same format.
  const persisted = {
    version: 1,
    activeKey: snapshot.activeKey,
    profiles: snapshot.profiles.map(asConnectionInput),
  };
  return JSON.stringify(persisted);
};

export const normalizeExecutorServerProfilesSnapshot = (input: {
  readonly activeKey?: string | null;
  readonly profiles?: readonly ExecutorServerConnectionInput[];
}): ExecutorServerProfilesSnapshot => {
  const deduped = new Map<string, ExecutorServerConnection>();
  for (const profile of input.profiles ?? []) {
    const normalized = normalizeConnectionOption(profile);
    if (!normalized) continue;
    deduped.set(normalized.key, normalized);
  }

  const profiles = [...deduped.values()];
  const activeKey =
    input.activeKey && deduped.has(input.activeKey) ? input.activeKey : (profiles[0]?.key ?? null);

  return { activeKey, profiles };
};

export const readExecutorServerProfiles = (
  storage: ExecutorServerProfileStorage | null | undefined,
  storageKey = EXECUTOR_SERVER_PROFILES_STORAGE_KEY,
): ExecutorServerProfilesSnapshot => {
  if (!storage) return EMPTY_PROFILES;
  return parseExecutorServerProfilesSnapshot(storage.getItem(storageKey));
};

export const writeExecutorServerProfiles = (
  storage: ExecutorServerProfileStorage | null | undefined,
  snapshot: ExecutorServerProfilesSnapshot,
  storageKey = EXECUTOR_SERVER_PROFILES_STORAGE_KEY,
): void => {
  if (!storage) return;
  storage.setItem(storageKey, serializeExecutorServerProfilesSnapshot(snapshot));
};

export const getActiveExecutorServerProfile = (
  snapshot: ExecutorServerProfilesSnapshot,
): ExecutorServerConnection | null =>
  snapshot.profiles.find((profile) => profile.key === snapshot.activeKey) ?? null;

export const upsertExecutorServerProfile = (
  snapshot: ExecutorServerProfilesSnapshot,
  input: ExecutorServerConnectionInput,
  options: {
    readonly makeActive?: boolean;
  } = {},
): ExecutorServerProfilesSnapshot | null => {
  const normalized = normalizeConnectionOption(input);
  if (!normalized) return null;
  const profiles = new Map(snapshot.profiles.map((profile) => [profile.key, profile]));
  profiles.set(normalized.key, normalized);
  const activeKey =
    options.makeActive === false ? (snapshot.activeKey ?? normalized.key) : normalized.key;
  return normalizeExecutorServerProfilesSnapshot({
    activeKey,
    profiles: [...profiles.values()],
  });
};

export const selectExecutorServerProfile = (
  snapshot: ExecutorServerProfilesSnapshot,
  key: string,
): ExecutorServerProfilesSnapshot => {
  if (!snapshot.profiles.some((profile) => profile.key === key)) return snapshot;
  return { ...snapshot, activeKey: key };
};

export const removeExecutorServerProfile = (
  snapshot: ExecutorServerProfilesSnapshot,
  key: string,
): ExecutorServerProfilesSnapshot => {
  const profiles = snapshot.profiles.filter((profile) => profile.key !== key);
  return normalizeExecutorServerProfilesSnapshot({
    activeKey: snapshot.activeKey === key ? null : snapshot.activeKey,
    profiles,
  });
};
