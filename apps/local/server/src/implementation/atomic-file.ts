/**
 * Atomic file replacement for the files a data directory keeps: keys, its installation record and
 * the background service's files. It needs only the platform's file services, so clients such as
 * Executor desktop can use it without loading key setup.
 */
import { Effect, FileSystem, Path } from "effect";

/** Stage, fsync and atomically rename so an interrupted write never leaves a partial file. */
export const writeAtomically = (
  platform: string,
  directory: string,
  destination: string,
  contents: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({
        directory,
        prefix: ".bootstrap-",
      });
      const staged = path.join(temporary, path.basename(destination));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(staged, { flag: "wx", mode: 0o600 });
          yield* file.writeAll(new TextEncoder().encode(contents));
          yield* file.sync;
        }),
      );
      // The create mode is masked by umask; set it explicitly as v1 did.
      yield* fs.chmod(staged, 0o600);
      yield* fs.rename(staged, destination);
      // Windows does not allow opening directories as ordinary file handles.
      if (platform !== "win32") {
        const parent = yield* fs.open(directory);
        yield* parent.sync;
      }
    }),
  );
