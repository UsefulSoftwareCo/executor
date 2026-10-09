/** Browser-safe public registry reads shared with server-side discovery. */
import { Effect, Option, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import {
  Publication,
  PublicationSnapshot,
  RegistryError,
  type Registry,
} from "../contracts/registry.ts";

const maxResponseBytes = 32 * 1024 * 1024;

/** Read a bounded response body; a stream failure is a network failure. */
const readBody = (response: HttpClientResponse.HttpClientResponse) =>
  response.stream.pipe(
    Stream.catch((error) =>
      error.reason instanceof HttpClientError.EmptyBodyError
        ? Stream.empty
        : Stream.fail(new RegistryError({ reason: "network" })),
    ),
    Stream.runFoldEffect(
      () => ({ size: 0, chunks: [] as Array<Uint8Array> }),
      (state, chunk) => {
        const size = state.size + chunk.length;
        if (size > maxResponseBytes) return Effect.fail(new RegistryError({ reason: "limit" }));
        state.chunks.push(chunk);
        return Effect.succeed({ size, chunks: state.chunks });
      },
    ),
    Effect.map(({ size, chunks }) => {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    }),
  );

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
      const response = yield* HttpClient.execute(HttpClientRequest.get(url)).pipe(
        Effect.mapError(() => new RegistryError({ reason: "network" })),
      );
      yield* Effect.annotateCurrentSpan("http.response.status_code", response.status);
      // Browsers expose a manual redirect as an opaque response with status 0.
      if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
        // Taking one chunk ends the stream early, which cancels the unread body.
        yield* Stream.runDrain(Stream.take(response.stream, 1)).pipe(Effect.ignore);
        return yield* new RegistryError({ reason: "status", status: response.status });
      }
      const body = yield* readBody(response);
      const value = parseJson(body);
      if (response.status < 200 || response.status >= 300) {
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
      // Browsers, Node, Bun, and workerd all support "manual"; workerd rejects "error".
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      // Trace headers would make a browser's cross-origin read a preflighted request.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
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
