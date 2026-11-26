import { Effect, Layer, type Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { wireRevision, wireRevisionHeader } from "@executor-js/sdk";

export const inProcessOrigin = "http://executor.internal";

const addressHost = HttpClient.mapRequest((request) =>
  request.url.startsWith("/") ? HttpClientRequest.prependUrl(request, inProcessOrigin) : request,
);
const stateRevision = HttpClient.mapRequest(
  HttpClientRequest.setHeader(wireRevisionHeader, String(wireRevision)),
);

export const dashboardHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    stateRevision(typeof window === "undefined" ? addressHost(client) : client),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

export const requestKey = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(requestKey).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${requestKey(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

export const hydrated = <R extends object>(
  request: R,
): R & { readonly serializationKey: string; readonly skipInitialRun: true } => ({
  ...request,
  serializationKey: requestKey(request),
  skipInitialRun: true,
});

export const hydratedResult =
  (options: {
    readonly key: string;
    readonly success: Schema.Constraint;
    readonly error?: Schema.Constraint;
  }) =>
  <R extends Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>>(atom: R): R =>
    Atom.serializable(atom, {
      key: options.key,
      schema: AsyncResult.Schema({
        success: options.success,
        ...(options.error === undefined ? {} : { error: options.error }),
      }) as unknown as Schema.Codec<Atom.Type<R>, unknown>,
      skipInitialRun: true,
    });

const notLoaded = AsyncResult.initial();

export const browserOnly = <A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): Atom.Atom<AsyncResult.AsyncResult<A, E>> =>
  typeof window === "undefined"
    ? Atom.make<AsyncResult.AsyncResult<A, E>>(notLoaded)
    : Atom.withServerValue(atom, () => notLoaded);

export const dashboardAuthClientOptions: { readonly baseURL?: string } =
  typeof window === "undefined" ? { baseURL: `${inProcessOrigin}/api/auth` } : {};
