/** The HTTP client dashboard reads use in the browser and while rendering on the server. */
import { Effect, Layer, type Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

/**
 * Server-rendered reads have no page location to resolve relative URLs against, so they address
 * the host through this origin. It never reaches a network: the document's in-process fetch
 * maps it to the host's own request pipeline.
 */
export const inProcessOrigin = "http://executor.internal";

const addressHost = HttpClient.mapRequest((request) =>
  request.url.startsWith("/") ? HttpClientRequest.prependUrl(request, inProcessOrigin) : request,
);

/**
 * Effect's Fetch client with the runtime's `Fetch`: the browser's, or on the server the
 * document's in-process fetch supplied by the dashboard atom runtime.
 */
export const dashboardHttpClient: Layer.Layer<HttpClient.HttpClient> =
  typeof window === "undefined"
    ? Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, addressHost)).pipe(
        Layer.provide(FetchHttpClient.layer),
      )
    : FetchHttpClient.layer;

/** A deterministic key for a request, independent of property order. */
export const requestKey = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(requestKey).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${requestKey(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

/**
 * Key a query by its request so a server render's settled value reaches the browser with the
 * page, and the browser reads it instead of requesting it again.
 */
export const hydrated = <R extends object>(
  request: R,
): R & { readonly serializationKey: string } => ({
  ...request,
  serializationKey: requestKey(request),
});

/**
 * Send a server-rendered read's settled value to the browser with the page. `success` and `error`
 * describe the atom's value; a value they cannot encode, such as a transport failure, is not
 * sent and the browser reads it again.
 */
export const hydratedResult =
  (options: {
    readonly key: string;
    readonly success: Schema.Constraint;
    readonly error?: Schema.Constraint;
  }) =>
  <R extends Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>>(atom: R): R =>
    // Encoding validates every value against the codec and skips those it rejects, and decoding
    // produces values of the same schemas, so the atom keeps its declared type.
    Atom.serializable(atom, {
      key: options.key,
      schema: AsyncResult.Schema({
        success: options.success,
        ...(options.error === undefined ? {} : { error: options.error }),
      }) as unknown as Schema.Codec<Atom.Type<R>, unknown>,
    });

/**
 * A read that is not sent with the page. The server renders its loading state and the browser
 * requests it after hydration, so both render the same markup.
 */
export const browserOnly = <A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): Atom.Atom<AsyncResult.AsyncResult<A, E>> =>
  typeof window === "undefined" ? Atom.make(AsyncResult.initial<A, E>()) : atom;

/**
 * Better Auth client options for dashboard code. On the server there is no page origin, and the
 * library would otherwise read the host's own configuration; address the host in-process instead.
 */
export const dashboardAuthClientOptions: { readonly baseURL?: string } =
  typeof window === "undefined" ? { baseURL: `${inProcessOrigin}/api/auth` } : {};
