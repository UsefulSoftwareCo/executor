import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { FileSystem, Option, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as Effect from "effect/Effect";

import {
  normalizeExecutorServerConnection,
  type ExecutorServerAuth,
  type ExecutorServerConnection,
  type ExecutorServerConnectionInput,
} from "@executor-js/sdk/shared";
import { decodeAccessTokenClaims } from "./device-login";
import { isPidAlive } from "./daemon-state";

export interface CliServerAccountIdentity {
  readonly subject?: string;
  readonly organizationId?: string;
  readonly email?: string;
}

export interface CliServerConnectionProfile {
  readonly name: string;
  readonly connection: ExecutorServerConnection;
  /** Stable account metadata survives logout so a later login can reuse the
   * same profile without retaining an access token solely for identification. */
  readonly account?: CliServerAccountIdentity;
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

const serverConnectionStoreLockPath = (path: Path.Path): string =>
  `${serverConnectionStorePath(path)}.lock`;

const serverConnectionStoreLockTombstonePath = (lockPath: string): string =>
  `${lockPath}.tombstone-${randomUUID()}`;

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

const PersistedAccount = Schema.Struct({
  subject: Schema.optional(Schema.String),
  organizationId: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});

const PersistedProfile = Schema.Struct({
  name: Schema.String,
  connection: PersistedConnection,
  account: Schema.optional(PersistedAccount),
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

const nonEmpty = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
};

const normalizeAccountIdentity = (
  input: CliServerAccountIdentity | undefined,
): CliServerAccountIdentity | undefined => {
  const subject = nonEmpty(input?.subject);
  const organizationId = nonEmpty(input?.organizationId);
  const email = nonEmpty(input?.email)?.toLowerCase();
  if (!subject && !email) return undefined;
  return {
    ...(subject ? { subject } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(email ? { email } : {}),
  };
};

/** Legacy version-1 profiles predate persisted account metadata. Derive it
 * from their OAuth token once, then the next login writes it explicitly. */
const legacyAccountIdentity = (
  profile: CliServerConnectionProfile,
): CliServerAccountIdentity | undefined => {
  const auth = profile.connection.auth;
  if (!auth || auth.kind !== "oauth") return undefined;
  const claims = decodeAccessTokenClaims(auth.accessToken);
  return normalizeAccountIdentity({
    subject: typeof claims?.sub === "string" ? claims.sub : undefined,
    organizationId: typeof claims?.org_id === "string" ? claims.org_id : undefined,
    email:
      typeof claims?.email === "string"
        ? claims.email
        : profile.connection.displayName.includes("@")
          ? profile.connection.displayName
          : undefined,
  });
};

const accountIdentityKey = (
  origin: string,
  account: CliServerAccountIdentity | undefined,
): string | undefined => {
  const normalized = normalizeAccountIdentity(account);
  if (!normalized) return undefined;
  const principal = normalized.subject
    ? ["subject", normalized.subject]
    : ["email", normalized.email ?? ""];
  return JSON.stringify([origin, ...principal, normalized.organizationId ?? null]);
};

const profileAccountIdentityKey = (profile: CliServerConnectionProfile): string | undefined =>
  accountIdentityKey(profile.connection.origin, profile.account ?? legacyAccountIdentity(profile));

export const cliServerConnectionProfileRows = (
  store: CliServerConnectionStore,
  environmentAuth: ExecutorServerAuth | undefined,
) =>
  store.profiles.map((profile) => {
    const account = profile.account ?? legacyAccountIdentity(profile);
    return {
      marker: profile.name === store.defaultProfile ? "*" : " ",
      name: profile.name,
      kind: profile.connection.kind,
      origin: profile.connection.origin,
      displayName: profile.connection.displayName,
      auth: profile.connection.auth ? "stored-auth" : environmentAuth ? "env-auth" : "signed-out",
      account: account?.email ?? account?.subject ?? "-",
      organization: account?.organizationId ?? "-",
    };
  });

export const parseCliServerConnectionStore = (raw: string): CliServerConnectionStore => {
  const decoded = decodeStoreJson(raw);
  if (Option.isNone(decoded)) return emptyCliServerConnectionStore;
  const record = decoded.value;

  const profiles = record.profiles.flatMap((value): readonly CliServerConnectionProfile[] => {
    const connection = decodeConnection(value.connection);
    if (!connection) return [];
    try {
      const account = normalizeAccountIdentity(value.account);
      return [
        {
          name: validateCliServerConnectionProfileName(value.name),
          connection,
          ...(account ? { account } : {}),
        },
      ];
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

const readCliServerConnectionStoreUnlocked = (): Effect.Effect<
  CliServerConnectionStore,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storePath = serverConnectionStorePath(path);
    const raw = yield* fs
      .readFileString(storePath)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (raw === null) return emptyCliServerConnectionStore;
    // Repair permissions on legacy files as soon as they are read. New writes
    // are also created owner-only below.
    yield* fs.chmod(storePath, 0o600).pipe(Effect.ignore);
    return parseCliServerConnectionStore(raw);
  });

export const readCliServerConnectionStore = (): Effect.Effect<
  CliServerConnectionStore,
  never,
  FileSystem.FileSystem | Path.Path
> => readCliServerConnectionStoreUnlocked();

interface CliServerConnectionStoreLock {
  readonly path: string;
  readonly owner: string;
}

const STORE_LOCK_RETRY_MS = 25;
const STORE_LOCK_TIMEOUT_MS = 10_000;

const StoreLockPayload = Schema.Struct({
  pid: Schema.Number,
  owner: Schema.String,
});

const decodeStoreLock = Schema.decodeUnknownOption(Schema.fromJsonString(StoreLockPayload));

const parseStoreLock = (raw: string) => {
  const decoded = decodeStoreLock(raw);
  return Option.isSome(decoded) ? decoded.value : null;
};

const readStoreLock = (fs: FileSystem.FileSystem, lockPath: string) =>
  fs.readFileString(lockPath).pipe(
    Effect.map(parseStoreLock),
    Effect.catchCause(() => Effect.succeed(null)),
  );

const listStoreLockTombstones = (fs: FileSystem.FileSystem, path: Path.Path, lockPath: string) => {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.tombstone-`;
  return fs.readDirectory(directory).pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => path.join(directory, entry)),
    ),
    Effect.catchCause(() => Effect.succeed([])),
  );
};

/** Canonical lock names can be replaced while a contender is suspended. Move
 * the path to a unique tombstone first, then only delete the exact owner that
 * was inspected. A mismatched live owner remains an advisory lock. */
const quarantineStaleStoreLock = (
  fs: FileSystem.FileSystem,
  lockPath: string,
  expected: { readonly pid: number; readonly owner: string },
) =>
  Effect.gen(function* () {
    const tombstonePath = serverConnectionStoreLockTombstonePath(lockPath);
    const moved = yield* fs.rename(lockPath, tombstonePath).pipe(
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false)),
    );
    if (!moved) return;

    const quarantined = yield* readStoreLock(fs, tombstonePath);
    if (
      quarantined?.owner === expected.owner &&
      quarantined.pid === expected.pid &&
      !isPidAlive(quarantined.pid)
    ) {
      yield* fs.remove(tombstonePath, { force: true }).pipe(Effect.ignore);
    }
  });

const inspectStoreLockTombstones = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  lockPath: string,
  owner: string,
) =>
  Effect.gen(function* () {
    const tombstonePaths = yield* listStoreLockTombstones(fs, path, lockPath);
    let hasOwnedLock = false;
    let hasOtherLiveLock = false;

    for (const tombstonePath of tombstonePaths) {
      const lock = yield* readStoreLock(fs, tombstonePath);
      if (!lock) {
        // Unknown tombstones are conservative advisory locks. They may be a
        // newly renamed lock whose payload has not become visible yet.
        hasOtherLiveLock = true;
      } else if (!isPidAlive(lock.pid)) {
        // Tombstone names are unique and never reused, so deleting this exact
        // dead owner's path has no compare-and-delete race.
        yield* fs.remove(tombstonePath, { force: true }).pipe(Effect.ignore);
      } else if (lock.owner === owner) {
        hasOwnedLock = true;
      } else {
        hasOtherLiveLock = true;
      }
    }

    return { hasOwnedLock, hasOtherLiveLock };
  });

const releaseOwnedCanonicalStoreLock = (
  fs: FileSystem.FileSystem,
  lockPath: string,
  owner: string,
) =>
  Effect.gen(function* () {
    const current = yield* readStoreLock(fs, lockPath);
    if (current?.owner !== owner) return;

    const tombstonePath = serverConnectionStoreLockTombstonePath(lockPath);
    const moved = yield* fs.rename(lockPath, tombstonePath).pipe(
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false)),
    );
    if (!moved) return;

    const quarantined = yield* readStoreLock(fs, tombstonePath);
    if (quarantined?.owner === owner) {
      yield* fs.remove(tombstonePath, { force: true }).pipe(Effect.ignore);
    }
  });

const releaseOwnedStoreLocks = (lock: CliServerConnectionStoreLock) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* releaseOwnedCanonicalStoreLock(fs, lock.path, lock.owner);
    const tombstonePaths = yield* listStoreLockTombstones(fs, path, lock.path);
    for (const tombstonePath of tombstonePaths) {
      const tombstone = yield* readStoreLock(fs, tombstonePath);
      if (tombstone?.owner === lock.owner) {
        yield* fs.remove(tombstonePath, { force: true }).pipe(Effect.ignore);
      }
    }
  });

const acquireCliServerConnectionStoreLock = (): Effect.Effect<
  CliServerConnectionStoreLock,
  Error,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dataDir = resolveDataDir(path);
    const lockPath = serverConnectionStoreLockPath(path);
    const owner = randomUUID();
    const payload = `${JSON.stringify({ pid: process.pid, owner, startedAt: new Date().toISOString() })}\n`;
    const deadline = Date.now() + STORE_LOCK_TIMEOUT_MS;

    yield* fs.makeDirectory(dataDir, { recursive: true });

    for (;;) {
      const acquired = yield* fs
        .writeFileString(lockPath, payload, { flag: "wx", mode: 0o600 })
        .pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        );
      if (acquired) {
        const tombstones = yield* inspectStoreLockTombstones(fs, path, lockPath, owner);
        const canonical = yield* readStoreLock(fs, lockPath);
        const stillOwnsLock = canonical?.owner === owner || tombstones.hasOwnedLock;
        if (stillOwnsLock && !tombstones.hasOtherLiveLock) {
          return { path: lockPath, owner };
        }
        yield* releaseOwnedStoreLocks({ path: lockPath, owner });
      }

      const existing = yield* readStoreLock(fs, lockPath);
      if (existing && !isPidAlive(existing.pid)) {
        yield* quarantineStaleStoreLock(fs, lockPath, existing);
        continue;
      }

      if (Date.now() >= deadline) {
        return yield* Effect.fail(
          new Error("Timed out waiting to update the Executor server profile store."),
        );
      }
      yield* Effect.sleep(STORE_LOCK_RETRY_MS);
    }
  });

const releaseCliServerConnectionStoreLock = (
  lock: CliServerConnectionStoreLock,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> => releaseOwnedStoreLocks(lock);

const writeCliServerConnectionStoreUnlocked = (
  store: CliServerConnectionStore,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dataDir = resolveDataDir(path);
    const storePath = serverConnectionStorePath(path);
    const tempPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
    yield* fs.makeDirectory(dataDir, { recursive: true });
    try {
      yield* fs.writeFileString(tempPath, serializeCliServerConnectionStore(store), {
        flag: "wx",
        mode: 0o600,
      });
      yield* fs.chmod(tempPath, 0o600).pipe(Effect.ignore);
      yield* fs.rename(tempPath, storePath);
      yield* fs.chmod(storePath, 0o600).pipe(Effect.ignore);
    } finally {
      yield* fs.remove(tempPath, { force: true }).pipe(Effect.ignore);
    }
  });

const withCliServerConnectionStoreLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    acquireCliServerConnectionStoreLock(),
    () => effect,
    releaseCliServerConnectionStoreLock,
  );

export const writeCliServerConnectionStore = (
  store: CliServerConnectionStore,
): Effect.Effect<void, Error | PlatformError, FileSystem.FileSystem | Path.Path> =>
  withCliServerConnectionStoreLock(writeCliServerConnectionStoreUnlocked(store));

export const upsertCliServerConnectionProfile = (input: {
  readonly name: string;
  readonly connection: ExecutorServerConnectionInput;
  readonly makeDefault: boolean;
}): Effect.Effect<
  CliServerConnectionStore,
  Error | PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  withCliServerConnectionStoreLock(
    Effect.gen(function* () {
      const name = validateCliServerConnectionProfileName(input.name);
      const store = yield* readCliServerConnectionStoreUnlocked();
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
      yield* writeCliServerConnectionStoreUnlocked(nextStore);
      return nextStore;
    }),
  );

const uniqueProfileName = (store: CliServerConnectionStore, suggestedName: string): string => {
  const base = validateCliServerConnectionProfileName(suggestedName);
  if (!store.profiles.some((profile) => profile.name === base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!store.profiles.some((profile) => profile.name === candidate)) return candidate;
  }
};

/** Save a device login while choosing its profile under the same lock as the
 * write. Persisted account metadata lets a logout and later re-login reuse the
 * original profile without keeping credentials around. */
export const upsertCliServerLoginProfile = (input: {
  readonly name?: string;
  readonly suggestedName: string;
  readonly account?: CliServerAccountIdentity;
  readonly connection: ExecutorServerConnectionInput;
}): Effect.Effect<
  { readonly store: CliServerConnectionStore; readonly profile: CliServerConnectionProfile },
  Error | PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  withCliServerConnectionStoreLock(
    Effect.gen(function* () {
      const store = yield* readCliServerConnectionStoreUnlocked();
      const account = normalizeAccountIdentity(input.account);
      const identity = accountIdentityKey(
        normalizeExecutorServerConnection(input.connection).origin,
        account,
      );
      const existing = identity
        ? store.profiles.find((profile) => profileAccountIdentityKey(profile) === identity)
        : undefined;
      const name = input.name
        ? validateCliServerConnectionProfileName(input.name)
        : (existing?.name ?? uniqueProfileName(store, input.suggestedName));
      const connection = normalizeExecutorServerConnection({
        ...input.connection,
        key: `profile:${name}`,
        displayName: input.connection.displayName ?? name,
      });
      const profile: CliServerConnectionProfile = {
        name,
        connection,
        ...(account ? { account } : {}),
      };
      const profiles = [
        ...store.profiles.filter((candidate) => candidate.name !== name),
        profile,
      ].sort((left, right) => left.name.localeCompare(right.name));
      const nextStore: CliServerConnectionStore = {
        version: 1,
        defaultProfile: name,
        profiles,
      };
      yield* writeCliServerConnectionStoreUnlocked(nextStore);
      return { store: nextStore, profile };
    }),
  );

/** Clear only the named profile's local credential. Account metadata remains
 * so re-authentication can safely reuse this profile. */
export const clearCliServerConnectionProfileAuth = (
  name: string,
): Effect.Effect<
  CliServerConnectionStore,
  Error | PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  withCliServerConnectionStoreLock(
    Effect.gen(function* () {
      const profileName = validateCliServerConnectionProfileName(name);
      const store = yield* readCliServerConnectionStoreUnlocked();
      const profile = store.profiles.find((candidate) => candidate.name === profileName);
      if (!profile)
        return yield* Effect.fail(new Error(`No server profile named "${profileName}".`));
      if (!profile.connection.auth) return store;
      const account = profile.account ?? legacyAccountIdentity(profile);
      const connection = normalizeExecutorServerConnection({
        kind: profile.connection.kind,
        key: `profile:${profileName}`,
        origin: profile.connection.origin,
        apiBaseUrl: profile.connection.apiBaseUrl,
        displayName: profile.connection.displayName,
      });
      const nextStore: CliServerConnectionStore = {
        ...store,
        profiles: store.profiles.map((candidate) =>
          candidate.name === profileName
            ? { ...candidate, connection, ...(account ? { account } : {}) }
            : candidate,
        ),
      };
      yield* writeCliServerConnectionStoreUnlocked(nextStore);
      return nextStore;
    }),
  );

/** Persist a refresh only if the profile still carries the token that started
 * it. A concurrent logout or re-login must not be overwritten by stale work. */
export const updateCliServerConnectionProfileAfterOAuthRefresh = (input: {
  readonly name: string;
  readonly previousAccessToken: string;
  readonly connection: ExecutorServerConnectionInput;
}): Effect.Effect<boolean, Error | PlatformError, FileSystem.FileSystem | Path.Path> =>
  withCliServerConnectionStoreLock(
    Effect.gen(function* () {
      const name = validateCliServerConnectionProfileName(input.name);
      const store = yield* readCliServerConnectionStoreUnlocked();
      const profile = store.profiles.find((candidate) => candidate.name === name);
      const auth = profile?.connection.auth;
      if (
        !profile ||
        !auth ||
        auth.kind !== "oauth" ||
        auth.accessToken !== input.previousAccessToken
      ) {
        return false;
      }
      const connection = normalizeExecutorServerConnection({
        ...input.connection,
        key: `profile:${name}`,
      });
      const nextStore: CliServerConnectionStore = {
        ...store,
        profiles: store.profiles.map((candidate) =>
          candidate.name === name ? { ...candidate, connection } : candidate,
        ),
      };
      yield* writeCliServerConnectionStoreUnlocked(nextStore);
      return true;
    }),
  );

export const setDefaultCliServerConnectionProfile = (
  name: string,
): Effect.Effect<
  CliServerConnectionStore,
  Error | PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  withCliServerConnectionStoreLock(
    Effect.gen(function* () {
      const profileName = validateCliServerConnectionProfileName(name);
      const store = yield* readCliServerConnectionStoreUnlocked();
      if (!store.profiles.some((profile) => profile.name === profileName)) {
        return yield* Effect.fail(new Error(`No server profile named "${profileName}".`));
      }
      const nextStore: CliServerConnectionStore = { ...store, defaultProfile: profileName };
      yield* writeCliServerConnectionStoreUnlocked(nextStore);
      return nextStore;
    }),
  );

export const removeCliServerConnectionProfile = (
  name: string,
): Effect.Effect<
  CliServerConnectionStore,
  Error | PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  withCliServerConnectionStoreLock(
    Effect.gen(function* () {
      const profileName = validateCliServerConnectionProfileName(name);
      const store = yield* readCliServerConnectionStoreUnlocked();
      const nextProfiles = store.profiles.filter((profile) => profile.name !== profileName);
      const nextStore: CliServerConnectionStore = {
        version: 1,
        defaultProfile: store.defaultProfile === profileName ? null : store.defaultProfile,
        profiles: nextProfiles,
      };
      yield* writeCliServerConnectionStoreUnlocked(nextStore);
      return nextStore;
    }),
  );

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
