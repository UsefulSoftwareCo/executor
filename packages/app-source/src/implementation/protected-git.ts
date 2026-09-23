/** Protect retained source refs even when ordinary app branches are force-pushed or deleted. */
import { Effect } from "effect";
import { SourceError, type RepositoryBackend } from "../contracts/repositories.ts";

const readPush = async (request: Request): Promise<Uint8Array> => {
  if (request.headers.has("content-encoding")) throw new SourceError({ reason: "protected" });
  const reader = request.body?.getReader();
  if (reader === undefined) throw new SourceError({ reason: "git" });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 32 * 1024 * 1024) throw new SourceError({ reason: "limit" });
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

/** Validate the entire receive-pack command list before forwarding any pack bytes. */
export const protectGit = (backend: RepositoryBackend): RepositoryBackend => ({
  ...backend,
  request: (id, request) =>
    Effect.gen(function* () {
      if (!new URL(request.url).pathname.endsWith("/git-receive-pack"))
        return yield* backend.request(id, request);
      const bytes = yield* Effect.tryPromise({
        try: () => readPush(request),
        catch: () => new SourceError({ reason: "protected" }),
      });
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let offset = 0;
      let commands = 0;
      for (;;) {
        const prefix = new TextDecoder().decode(bytes.subarray(offset, offset + 4));
        if (!/^[a-fA-F0-9]{4}$/.test(prefix))
          return yield* new SourceError({ reason: "protected" });
        const length = Number.parseInt(prefix, 16);
        if (length === 0) break;
        if (length < 4 || offset + length > bytes.length)
          return yield* new SourceError({ reason: "protected" });
        const line = yield* Effect.try({
          try: () => decoder.decode(bytes.subarray(offset + 4, offset + length)),
          catch: () => new SourceError({ reason: "protected" }),
        });
        const command = /^([a-f0-9]{40}) ([a-f0-9]{40}) (refs\/[^\s\0]+)(?:\0[^\n]*)?\n?$/.exec(
          line,
        );
        if (
          command?.[3] === undefined ||
          command[3].startsWith("refs/heads/__executor/") ||
          (command[3] === "refs/heads/main" && command[2] === "0".repeat(40))
        )
          return yield* new SourceError({ reason: "protected" });
        commands += 1;
        offset += length;
      }
      if (commands === 0) return yield* new SourceError({ reason: "protected" });
      return yield* backend.request(
        id,
        new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: Uint8Array.from(bytes),
        }),
      );
    }),
});
