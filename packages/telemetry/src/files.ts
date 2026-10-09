/** Product-owned JSONL diagnostics, independent of collector health. */
import { Console, Effect, FileSystem, Logger, Path, Semaphore } from "effect";

/**
 * Batch native JSON logs and retain five files of about 10 MiB each. Write every 250 ms and on
 * scope close.
 */
export const rotatingJsonLogger = (directory: string, name: string, maxBytes = 10 * 1024 * 1024) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${name}.jsonl`);
    let size = (yield* fs.exists(file)) ? Number((yield* fs.stat(file)).size) : 0;
    const lock = yield* Semaphore.make(1);
    const encoder = new TextEncoder();
    // Unbounded, as with `Logger.batched`: a hold is one append, plus one rename during a reset.
    let buffer: Array<string> = [];

    // Callers hold `lock`, so no write can start while the directory moves.
    const writeBuffered = Effect.suspend(() => {
      const lines = buffer;
      buffer = [];
      return Effect.gen(function* () {
        if (lines.length === 0) return;
        // The directory can be moved away, as a desktop data reset does. Start a new file.
        if (!(yield* fs.exists(file))) {
          yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
          size = 0;
        }
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
      }).pipe(
        Effect.catch((error) => Console.error("Could not write Executor diagnostics", error)),
      );
    });
    const flush = Effect.uninterruptible(lock.withPermit(writeBuffered));
    yield* Effect.sleep("250 millis").pipe(
      Effect.andThen(flush),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() => flush);

    return {
      logger: Logger.make((options) => {
        buffer.push(Logger.formatJson.log(options));
      }),
      /**
       * Write every buffered line, then hold writes while `move` moves the directory away. Lines
       * logged before the move go with it; later lines start a new file at the original path.
       *
       * The write and the move each finish once started, so an interruption cannot drop the taken
       * lines or release the lock mid-rename. One between them skips the move and leaves the lines
       * in place. `move` should be a single same-volume rename.
       */
      whileMoving: <A, E, R>(move: Effect.Effect<A, E, R>) =>
        lock.withPermit(
          Effect.uninterruptible(writeBuffered).pipe(Effect.andThen(Effect.uninterruptible(move))),
        ),
    };
  });
