import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as Effect from "effect/Effect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaemonRecord {
  readonly version: 1;
  readonly hostname: string;
  readonly port: number;
  readonly pid: number;
  readonly startedAt: string;
  readonly scopeDir: string | null;
}

export interface DaemonPointer {
  readonly version: 1;
  readonly hostname: string;
  readonly port: number;
  readonly pid: number;
  readonly startedAt: string;
  readonly scopeId: string;
  readonly scopeDir: string | null;
  readonly token: string;
}

export interface DaemonStartLock {
  readonly path: string;
  readonly hostname: string;
  readonly scopeId: string;
}

// ---------------------------------------------------------------------------
// Host normalization
// ---------------------------------------------------------------------------

const LOCAL_HOST_ALIASES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const canonicalDaemonHost = (hostname: string): string => {
  const normalized = hostname.trim().toLowerCase();
  return LOCAL_HOST_ALIASES.has(normalized) ? "localhost" : normalized;
};

export const currentDaemonScopeId = (): string => {
  const explicitScope = process.env.EXECUTOR_SCOPE_DIR?.trim();
  if (explicitScope && explicitScope.length > 0) {
    return `scope:${resolve(explicitScope)}`;
  }
  return `cwd:${resolve(process.cwd())}`;
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const resolveDaemonDataDir = (path: Path.Path): string =>
  process.env.EXECUTOR_DATA_DIR ?? path.join(homedir(), ".executor");

const sanitizeHostForPath = (hostname: string): string =>
  hostname.replaceAll(/[^a-z0-9.-]+/gi, "_");
const scopeKeyForPath = (scopeId: string): string =>
  createHash("sha256").update(scopeId).digest("hex").slice(0, 24);

const daemonRecordPath = (path: Path.Path, input: { hostname: string; port: number }): string => {
  const host = sanitizeHostForPath(canonicalDaemonHost(input.hostname));
  return path.join(resolveDaemonDataDir(path), `daemon-${host}-${input.port}.json`);
};

const daemonPointerPath = (
  path: Path.Path,
  input: { hostname: string; scopeId: string },
): string => {
  const host = sanitizeHostForPath(canonicalDaemonHost(input.hostname));
  const scope = scopeKeyForPath(input.scopeId);
  return path.join(resolveDaemonDataDir(path), `daemon-active-${host}-${scope}.json`);
};

const daemonStartLockPath = (
  path: Path.Path,
  input: { hostname: string; scopeId: string },
): string => `${daemonPointerPath(path, input)}.lock`;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export const writeDaemonRecord = (input: {
  hostname: string;
  port: number;
  pid: number;
  scopeDir: string | null;
}): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dataDir = resolveDaemonDataDir(path);

    yield* fs.makeDirectory(dataDir, { recursive: true });

    const payload: DaemonRecord = {
      version: 1,
      hostname: canonicalDaemonHost(input.hostname),
      port: input.port,
      pid: input.pid,
      startedAt: new Date().toISOString(),
      scopeDir: input.scopeDir,
    };

    yield* fs.writeFileString(
      daemonRecordPath(path, { hostname: input.hostname, port: input.port }),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  });

const parseRecord = (raw: string): DaemonRecord | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    (parsed as { version?: unknown }).version !== 1
  ) {
    return null;
  }

  const r = parsed as Record<string, unknown>;
  if (
    typeof r.hostname !== "string" ||
    typeof r.port !== "number" ||
    typeof r.pid !== "number" ||
    typeof r.startedAt !== "string" ||
    !(typeof r.scopeDir === "string" || r.scopeDir === null)
  ) {
    return null;
  }

  return {
    version: 1,
    hostname: canonicalDaemonHost(r.hostname),
    port: r.port,
    pid: r.pid,
    startedAt: r.startedAt,
    scopeDir: r.scopeDir,
  };
};

const parsePointer = (raw: string): DaemonPointer | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    (parsed as { version?: unknown }).version !== 1
  ) {
    return null;
  }

  const r = parsed as Record<string, unknown>;
  if (
    typeof r.hostname !== "string" ||
    typeof r.port !== "number" ||
    typeof r.pid !== "number" ||
    typeof r.startedAt !== "string" ||
    typeof r.scopeId !== "string" ||
    !(typeof r.scopeDir === "string" || r.scopeDir === null) ||
    typeof r.token !== "string"
  ) {
    return null;
  }

  return {
    version: 1,
    hostname: canonicalDaemonHost(r.hostname),
    port: r.port,
    pid: r.pid,
    startedAt: r.startedAt,
    scopeId: r.scopeId,
    scopeDir: r.scopeDir,
    token: r.token,
  };
};

export const readDaemonRecord = (input: {
  hostname: string;
  port: number;
}): Effect.Effect<DaemonRecord | null, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs
      .readFileString(daemonRecordPath(path, input))
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (raw === null) return null;
    return parseRecord(raw);
  });

export const removeDaemonRecord = (input: {
  hostname: string;
  port: number;
}): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.remove(daemonRecordPath(path, input), { force: true });
  });

export const writeDaemonPointer = (input: {
  hostname: string;
  port: number;
  pid: number;
  scopeId: string;
  scopeDir: string | null;
  token: string;
}): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dataDir = resolveDaemonDataDir(path);
    yield* fs.makeDirectory(dataDir, { recursive: true });

    const payload: DaemonPointer = {
      version: 1,
      hostname: canonicalDaemonHost(input.hostname),
      port: input.port,
      pid: input.pid,
      startedAt: new Date().toISOString(),
      scopeId: input.scopeId,
      scopeDir: input.scopeDir,
      token: input.token,
    };

    yield* fs.writeFileString(
      daemonPointerPath(path, { hostname: input.hostname, scopeId: input.scopeId }),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  });

export const readDaemonPointer = (input: {
  hostname: string;
  scopeId: string;
}): Effect.Effect<DaemonPointer | null, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs
      .readFileString(daemonPointerPath(path, input))
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (raw === null) return null;
    return parsePointer(raw);
  });

export const removeDaemonPointer = (input: {
  hostname: string;
  scopeId: string;
}): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.remove(daemonPointerPath(path, input), { force: true });
  });

const parseLockPid = (raw: string): number | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).pid !== "number"
  ) {
    return null;
  }

  return (parsed as Record<string, number>).pid;
};

export const acquireDaemonStartLock = (input: {
  hostname: string;
  scopeId: string;
}): Effect.Effect<DaemonStartLock, Error, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dataDir = resolveDaemonDataDir(path);
    yield* fs.makeDirectory(dataDir, { recursive: true });

    const lockPath = daemonStartLockPath(path, input);
    const lockPayload = JSON.stringify(
      {
        pid: process.pid,
        hostname: canonicalDaemonHost(input.hostname),
        scopeId: input.scopeId,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    );

    const tryAcquire = () =>
      fs.writeFileString(lockPath, `${lockPayload}\n`, { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false)),
      );

    if (yield* tryAcquire()) {
      return {
        path: lockPath,
        hostname: canonicalDaemonHost(input.hostname),
        scopeId: input.scopeId,
      };
    }

    const existingRaw = yield* fs
      .readFileString(lockPath)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (existingRaw !== null) {
      const existingPid = parseLockPid(existingRaw);
      if (existingPid !== null && !isPidAlive(existingPid)) {
        yield* fs.remove(lockPath, { force: true });
        if (yield* tryAcquire()) {
          return {
            path: lockPath,
            hostname: canonicalDaemonHost(input.hostname),
            scopeId: input.scopeId,
          };
        }
      }
    }

    return yield* Effect.fail(
      new Error(
        `Another daemon startup is already in progress for ${canonicalDaemonHost(input.hostname)} (${input.scopeId}).`,
      ),
    );
  });

export const releaseDaemonStartLock = (
  input: DaemonStartLock,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(input.path, { force: true });
  });

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

export const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const terminatePid = (pid: number): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => {
      process.kill(pid, "SIGTERM");
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`Failed to terminate pid ${pid}: ${String(cause)}`),
  });
