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

export const resolveExecutorDataDir = (path: Path.Path): string =>
  resolve(process.env.EXECUTOR_DATA_DIR ?? path.join(homedir(), ".executor"));

const serverControlDir = (path: Path.Path): string =>
  path.join(resolveExecutorDataDir(path), "server-control");

const localServerManifestPath = (path: Path.Path): string =>
  path.join(serverControlDir(path), "server.json");

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
    const manifestPath = localServerManifestPath(path);
    // The manifest embeds the bearer token; create it owner-only so there's no
    // window where it exists world-readable (mode applies only on create). The
    // chmod after covers overwriting a pre-existing world-readable file, where
    // the create mode is ignored.
    yield* fs.writeFileString(manifestPath, serializeExecutorLocalServerManifest(manifest), {
      mode: 0o600,
    });
    yield* fs.chmod(manifestPath, 0o600).pipe(Effect.ignore);
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

/**
 * Remove the server manifest unconditionally. Used by an OS-supervised daemon
 * to reclaim a stale `server.json` left by a previous boot: across a reboot the
 * recorded pid is meaningless (pids recycle, so it may now belong to an
 * unrelated process), and launchd/systemd already guarantee a single supervised
 * instance — so any pre-existing manifest is stale and the supervised daemon
 * owns it.
 */
export const removeLocalServerManifest = (): Effect.Effect<
  void,
  PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.remove(localServerManifestPath(path), { force: true });
  });
