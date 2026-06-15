import { homedir } from "node:os";
import { FileSystem, Option, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as Effect from "effect/Effect";

import {
  normalizeExecutorServerConnection,
  type ExecutorServerConnection,
  type ExecutorServerConnectionInput,
} from "@executor-js/sdk/shared";

export interface CliServerConnectionProfile {
  readonly name: string;
  readonly connection: ExecutorServerConnection;
}

export interface CliServerConnectionStore {
  readonly version: 1;
  readonly defaultProfile: string | null;
  readonly profiles: readonly CliServerConnectionProfile[];
}

export const emptyCliServerConnectionStore: CliServerConnectionStore = {
  version: 1,
  defaultProfile: null,
  profiles: [],
};

export const validateCliServerConnectionProfileName = (name: string): string => {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new Error(
      "Server profile names may contain only letters, numbers, dots, underscores, and dashes.",
    );
  }
  return trimmed;
};

const resolveDataDir = (path: Path.Path): string =>
  process.env.EXECUTOR_DATA_DIR ?? path.join(homedir(), ".executor");

const serverConnectionStorePath = (path: Path.Path): string =>
  path.join(resolveDataDir(path), "server-connections.json");

const PersistedAuth = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("basic"),
    username: Schema.optional(Schema.String),
    password: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("bearer"),
    token: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth"),
    accessToken: Schema.String,
    refreshToken: Schema.optional(Schema.String),
    expiresAt: Schema.optional(Schema.Number),
    tokenEndpoint: Schema.optional(Schema.String),
    clientId: Schema.optional(Schema.String),
  }),
]);

const PersistedConnection = Schema.Struct({
  kind: Schema.optional(Schema.Literals(["http", "desktop-sidecar"])),
  key: Schema.optional(Schema.String),
  origin: Schema.optional(Schema.String),
  apiBaseUrl: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  auth: Schema.optional(PersistedAuth),
});

const PersistedProfile = Schema.Struct({
  name: Schema.String,
  connection: PersistedConnection,
});

const PersistedStore = Schema.Struct({
  version: Schema.Literal(1),
  defaultProfile: Schema.optional(Schema.NullOr(Schema.String)),
  profiles: Schema.Array(PersistedProfile),
});

const decodeStoreJson = Schema.decodeUnknownOption(Schema.fromJsonString(PersistedStore));

const decodeConnection = (
  input: ExecutorServerConnectionInput,
): ExecutorServerConnection | null => {
  if (!input.origin && !input.apiBaseUrl) return null;
  return normalizeExecutorServerConnection(input);
};

export const parseCliServerConnectionStore = (raw: string): CliServerConnectionStore => {
  const decoded = decodeStoreJson(raw);
  if (Option.isNone(decoded)) return emptyCliServerConnectionStore;
  const record = decoded.value;

  const profiles = record.profiles.flatMap((value): readonly CliServerConnectionProfile[] => {
    const connection = decodeConnection(value.connection);
    if (!connection) return [];
    try {
      return [{ name: validateCliServerConnectionProfileName(value.name), connection }];
    } catch {
      return [];
    }
  });

  const defaultProfile =
    record.defaultProfile && profiles.some((profile) => profile.name === record.defaultProfile)
      ? record.defaultProfile
      : null;

  return {
    version: 1,
    defaultProfile,
    profiles,
  };
};

const serializeCliServerConnectionStore = (store: CliServerConnectionStore): string =>
  `${JSON.stringify(store, null, 2)}\n`;

export const readCliServerConnectionStore = (): Effect.Effect<
  CliServerConnectionStore,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs
      .readFileString(serverConnectionStorePath(path))
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (raw === null) return emptyCliServerConnectionStore;
    return parseCliServerConnectionStore(raw);
  });

export const writeCliServerConnectionStore = (
  store: CliServerConnectionStore,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dataDir = resolveDataDir(path);
    yield* fs.makeDirectory(dataDir, { recursive: true });
    yield* fs.writeFileString(
      serverConnectionStorePath(path),
      serializeCliServerConnectionStore(store),
    );
  });

export const upsertCliServerConnectionProfile = (input: {
  readonly name: string;
  readonly connection: ExecutorServerConnectionInput;
  readonly makeDefault: boolean;
}): Effect.Effect<CliServerConnectionStore, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const name = validateCliServerConnectionProfileName(input.name);
    const store = yield* readCliServerConnectionStore();
    const connection = normalizeExecutorServerConnection({
      ...input.connection,
      key: input.connection.key ?? `profile:${name}`,
      displayName: input.connection.displayName ?? name,
    });
    const nextProfiles = [
      ...store.profiles.filter((profile) => profile.name !== name),
      { name, connection },
    ].sort((a, b) => a.name.localeCompare(b.name));
    const nextStore: CliServerConnectionStore = {
      version: 1,
      defaultProfile:
        input.makeDefault || store.defaultProfile === null ? name : store.defaultProfile,
      profiles: nextProfiles,
    };
    yield* writeCliServerConnectionStore(nextStore);
    return nextStore;
  });

export const setDefaultCliServerConnectionProfile = (
  name: string,
): Effect.Effect<
  CliServerConnectionStore,
  Error | PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const profileName = validateCliServerConnectionProfileName(name);
    const store = yield* readCliServerConnectionStore();
    if (!store.profiles.some((profile) => profile.name === profileName)) {
      return yield* Effect.fail(new Error(`No server profile named "${profileName}".`));
    }
    const nextStore: CliServerConnectionStore = { ...store, defaultProfile: profileName };
    yield* writeCliServerConnectionStore(nextStore);
    return nextStore;
  });

export const removeCliServerConnectionProfile = (
  name: string,
): Effect.Effect<CliServerConnectionStore, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const profileName = validateCliServerConnectionProfileName(name);
    const store = yield* readCliServerConnectionStore();
    const nextProfiles = store.profiles.filter((profile) => profile.name !== profileName);
    const nextStore: CliServerConnectionStore = {
      version: 1,
      defaultProfile: store.defaultProfile === profileName ? null : store.defaultProfile,
      profiles: nextProfiles,
    };
    yield* writeCliServerConnectionStore(nextStore);
    return nextStore;
  });

export const findCliServerConnectionProfile = (
  store: CliServerConnectionStore,
  name: string,
): CliServerConnectionProfile | null => {
  const profileName = validateCliServerConnectionProfileName(name);
  return store.profiles.find((profile) => profile.name === profileName) ?? null;
};

export const defaultCliServerConnectionProfile = (
  store: CliServerConnectionStore,
): CliServerConnectionProfile | null =>
  store.defaultProfile ? findCliServerConnectionProfile(store, store.defaultProfile) : null;
