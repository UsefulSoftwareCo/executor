/** Browser-safe public registry reads shared with server-side discovery. */
import { Effect, Option, Schema } from "effect";
import {
  Publication,
  PublicationSnapshot,
  RegistryError,
  type Registry,
} from "./contracts/registry.ts";

const maxResponseBytes = 32 * 1024 * 1024;

/** Read a bounded response body; a stream failure is a network failure. */
const readBody = async (response: Response) => {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read().catch(() => {
        throw new RegistryError({ reason: "network" });
      });
      if (part.done) break;
      size += part.value.length;
      if (size > maxResponseBytes) throw new RegistryError({ reason: "limit" });
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

const parseJson = (bytes: Uint8Array): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return Option.none();
  }
};

/** Read the public catalog through its configured HTTPS origin; installation validates the selected revision. */
export const remoteRegistry = (origin: string): Registry => {
  const read = <A>(operation: string, path: string, schema: Schema.Decoder<A>) => {
    const url = new URL(path, origin);
    return Effect.gen(function* () {
      // Browsers, Node, Bun, and workerd all support "manual"; workerd rejects "error".
      const response = yield* Effect.tryPromise({
        try: (signal) => fetch(url, { signal, redirect: "manual" }),
        catch: () => new RegistryError({ reason: "network" }),
      });
      yield* Effect.annotateCurrentSpan("http.response.status_code", response.status);
      // Browsers expose a manual redirect as an opaque response with status 0.
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        yield* Effect.promise(
          () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
        );
        return yield* new RegistryError({ reason: "status", status: response.status });
      }
      const body = yield* Effect.tryPromise({
        try: () => readBody(response),
        catch: (error) =>
          Schema.is(RegistryError)(error) ? error : new RegistryError({ reason: "network" }),
      });
      const value = parseJson(body);
      if (!response.ok) {
        const error = Option.flatMap(value, (json) =>
          Schema.decodeUnknownOption(Schema.toCodecJson(RegistryError))(json),
        );
        return yield* Option.isSome(error)
          ? error.value
          : new RegistryError({ reason: "status", status: response.status });
      }
      if (Option.isNone(value)) return yield* new RegistryError({ reason: "invalid-response" });
      return yield* Schema.decodeUnknownEffect(schema)(value.value).pipe(
        Effect.mapError(() => new RegistryError({ reason: "invalid-source" })),
      );
    }).pipe(
      Effect.tapError((error) => Effect.annotateCurrentSpan("registry.error.reason", error.reason)),
      Effect.withSpan("registry.request", {
        attributes: {
          "registry.operation": operation,
          "server.address": url.host,
          "url.path": url.pathname,
        },
      }),
    );
  };
  return {
    origin,
    list: (name) =>
      read(
        "list",
        `/api/registry/apps${name === undefined ? "" : `?name=${encodeURIComponent(name)}`}`,
        Schema.Array(Publication),
      ),
    snapshot: (name, commit) =>
      read(
        "snapshot",
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
