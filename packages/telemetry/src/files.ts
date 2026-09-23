/** Product-owned JSONL diagnostics, independent of collector health. */
import { Console, Effect, FileSystem, Logger, Path, Semaphore } from "effect";

/** Batch native JSON logs and retain five files of about 10 MiB each. Flush on scope close. */
export const rotatingJsonLogger = (directory: string, name: string, maxBytes = 10 * 1024 * 1024) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${name}.jsonl`);
    let size = (yield* fs.exists(file)) ? Number((yield* fs.stat(file)).size) : 0;
    const lock = yield* Semaphore.make(1);
    const encoder = new TextEncoder();
    return yield* Logger.batched(Logger.formatJson, {
      window: 250,
      flush: (lines) =>
        lock
          .withPermit(
            Effect.gen(function* () {
              if (lines.length === 0) return;
              const bytes = encoder.encode(`${lines.join("\n")}\n`);
              if (size > 0 && size + bytes.length > maxBytes) {
                for (let index = 4; index >= 1; index--) {
                  const previous = index === 1 ? file : `${file}.${index - 1}`;
                  if (yield* fs.exists(previous)) yield* fs.rename(previous, `${file}.${index}`);
                }
                size = 0;
              }
              yield* fs.writeFile(file, bytes, { flag: "a", mode: 0o600 });
              size += bytes.length;
            }),
          )
          .pipe(
            Effect.catch((error) => Console.error("Could not write Executor diagnostics", error)),
          ),
    });
  });
