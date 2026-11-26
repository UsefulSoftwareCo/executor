import { Effect, FileSystem, Path } from "effect";

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
      yield* fs.chmod(staged, 0o600);
      yield* fs.rename(staged, destination);
      if (platform !== "win32") {
        const parent = yield* fs.open(directory);
        yield* parent.sync;
      }
    }),
  );
