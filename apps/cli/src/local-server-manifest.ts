import { homedir } from "node:os";
import { resolve } from "node:path";
import { FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as Effect from "effect/Effect";

import {
  parseExecutorLocalServerManifest,
  serializeExecutorLocalServerManifest,
  type ExecutorLocalServerManifest,
} from "@executor-js/sdk/shared";
import { isPidAlive } from "./daemon-state";

export interface LocalServerStartLock {
  readonly path: string;
}

export const resolveExecutorDataDir = (path: Path.Path): string =>
  resolve(process.env.EXECUTOR_DATA_DIR ?? path.join(homedir(), ".executor"));

const serverControlDir = (path: Path.Path): string =>
  path.join(resolveExecutorDataDir(path), "server-control");

const localServerManifestPath = (path: Path.Path): string =>
  path.join(serverControlDir(path), "server.json");

const localServerStartLockPath = (path: Path.Path): string =>
  path.join(serverControlDir(path), "startup.lock");

export const readLocalServerManifest = (): Effect.Effect<
  ExecutorLocalServerManifest | null,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs
      .readFileString(localServerManifestPath(path))
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (raw === null) return null;
    return parseExecutorLocalServerManifest(raw);
  });

export const writeLocalServerManifest = (
  manifest: ExecutorLocalServerManifest,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(serverControlDir(path), { recursive: true });
    yield* fs.writeFileString(
      localServerManifestPath(path),
      serializeExecutorLocalServerManifest(manifest),
    );
  });

export const removeLocalServerManifestIfOwnedBy = (input: {
  readonly pid: number;
}): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifestPath = localServerManifestPath(path);
    const raw = yield* fs
      .readFileString(manifestPath)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (raw === null) return;
    const manifest = parseExecutorLocalServerManifest(raw);
    if (manifest?.pid !== input.pid) return;
    yield* fs.remove(manifestPath, { force: true });
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
  return (parsed as { readonly pid: number }).pid;
};

export const acquireLocalServerStartLock = (): Effect.Effect<
  LocalServerStartLock,
  Error,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(serverControlDir(path), { recursive: true });

    const lockPath = localServerStartLockPath(path);
    const lockPayload = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`;

    const tryAcquire = () =>
      fs.writeFileString(lockPath, lockPayload, { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false)),
      );

    if (yield* tryAcquire()) return { path: lockPath };

    const existingRaw = yield* fs
      .readFileString(lockPath)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (existingRaw !== null) {
      const existingPid = parseLockPid(existingRaw);
      if (existingPid !== null && !isPidAlive(existingPid)) {
        yield* fs.remove(lockPath, { force: true });
        if (yield* tryAcquire()) return { path: lockPath };
      }
    }

    return yield* Effect.fail(
      new Error("Another local Executor server startup is already in progress."),
    );
  });

export const releaseLocalServerStartLock = (
  lock: LocalServerStartLock,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(lock.path, { force: true });
  });
