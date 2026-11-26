import { Console, Effect, FileSystem, Logger, Path, Semaphore } from "effect";

export const rotatingJsonLogger = (directory: string, name: string, maxBytes = 10 * 1024 * 1024) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${name}.jsonl`);
    let size = (yield* fs.exists(file)) ? Number((yield* fs.stat(file)).size) : 0;
    const lock = yield* Semaphore.make(1);
    const encoder = new TextEncoder();
    let buffer: Array<string> = [];

    const writeBuffered = Effect.suspend(() => {
      const lines = buffer;
      buffer = [];
      return Effect.gen(function* () {
        if (lines.length === 0) return;
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
      whileMoving: <A, E, R>(move: Effect.Effect<A, E, R>) =>
        lock.withPermit(
          Effect.uninterruptible(writeBuffered).pipe(Effect.andThen(Effect.uninterruptible(move))),
        ),
    };
  });
