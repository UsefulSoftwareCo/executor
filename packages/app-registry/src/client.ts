/** Browser-safe public registry reads shared with server-side discovery. */
import { Effect, Option, Schema } from "effect";
import {
  Publication,
  PublicationSnapshot,
  RegistryError,
  type Registry,
} from "./contracts/registry.ts";

/** Read the public catalog through its configured HTTPS origin; installation validates the selected revision. */
export const remoteRegistry = (origin: string): Registry => {
  const read = <A>(path: string, schema: Schema.Decoder<A>) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(new URL(path, origin), { signal, redirect: "error" });
        const reader = response.body?.getReader();
        if (reader === undefined) throw new Error("Registry response missing");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 32 * 1024 * 1024) throw new Error("Registry response too large");
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!response.ok) {
          const error = Schema.decodeUnknownOption(Schema.toCodecJson(RegistryError))(value);
          throw Option.isSome(error) ? error.value : new RegistryError({ reason: "registry" });
        }
        return value;
      },
      catch: (error) =>
        Schema.is(RegistryError)(error) ? error : new RegistryError({ reason: "registry" }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError((error) =>
        Schema.is(RegistryError)(error) ? error : new RegistryError({ reason: "invalid-source" }),
      ),
    );
  return {
    origin,
    list: (name) =>
      read(
        `/api/registry/apps${name === undefined ? "" : `?name=${encodeURIComponent(name)}`}`,
        Schema.Array(Publication),
      ),
    snapshot: (name, commit) =>
      read(
        `/api/registry/source?name=${encodeURIComponent(name)}&commit=${encodeURIComponent(commit)}`,
        PublicationSnapshot,
      ).pipe(
        Effect.flatMap((value) =>
          value.publication.name === name && value.publication.commit === commit
            ? Effect.succeed(value)
            : Effect.fail(new RegistryError({ reason: "changed" })),
        ),
      ),
  };
};
