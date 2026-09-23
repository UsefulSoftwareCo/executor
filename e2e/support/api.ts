/** Effect HTTP adapter with independent cookie jars, bounded requests, and safe evidence. */
import { Cause, Clock, Context, Effect, Layer, Redacted, Ref, Schema } from "effect";
import { Cookies, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { randomBytes } from "node:crypto";
import { Evidence } from "./evidence.ts";
import { Target, type Response } from "./platform.ts";

/** Serialized browser cookies are always wrapped as redacted values outside their driver. */
export const BrowserCookies = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    value: Schema.String,
    domain: Schema.String,
    path: Schema.String,
    httpOnly: Schema.Boolean,
    secure: Schema.Boolean,
    sameSite: Schema.Literals(["Strict", "Lax", "None"]),
    expires: Schema.Number,
  }),
);
export type BrowserCookies = typeof BrowserCookies.Type;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
/** Each actor owns its cookie jar; no session state can bleed into another actor. */
export interface Session {
  readonly cookies: Effect.Effect<Redacted.Redacted<BrowserCookies>>;
  readonly send: (
    method: Method,
    path: string,
    data?: unknown,
    headers?: Record<string, string>,
  ) => Effect.Effect<Response, RequestFailed>;
}
/** Request failures expose safe context; underlying errors remain redacted. */
export class RequestFailed extends Schema.TaggedError<RequestFailed>()("RequestFailed", {
  method: Schema.String,
  path: Schema.String,
  reason: Schema.Literals(["origin", "timeout", "request"]),
  cause: Schema.optional(Schema.Redacted(Schema.Unknown)),
}) {}
/** A server response may be decoded only against its public contract. */
export const body = <A>(schema: Schema.ConstraintDecoder<A, never>, response: Response) =>
  Schema.decodeUnknownEffect(schema)(response.body);
interface Sessions {
  readonly session: (cookies?: Redacted.Redacted<BrowserCookies>) => Effect.Effect<Session>;
  readonly request: (
    session: Session,
    method: Method,
    path: string,
    data?: unknown,
    headers?: Record<string, string>,
  ) => Effect.Effect<Response, RequestFailed>;
}
/** Run/suite-scoped HTTP construction. Session setup does not depend on case evidence. */
export class SessionClients extends Context.Service<SessionClients, Sessions>()(
  "e2e/SessionClients",
) {
  static readonly layer = Layer.effect(
    SessionClients,
    Effect.gen(function* () {
      const target = yield* Target,
        client = yield* HttpClient.HttpClient;
      const origin = target.metadata.origin;
      const session = (initial?: Redacted.Redacted<BrowserCookies>) =>
        Effect.gen(function* () {
          let initialJar = Cookies.empty;
          for (const cookie of initial ? Redacted.value(initial) : [])
            initialJar = Cookies.setUnsafe(
              initialJar,
              cookie.name,
              decodeURIComponent(cookie.value),
              {
                domain: cookie.domain,
                path: cookie.path,
                httpOnly: cookie.httpOnly,
                secure: cookie.secure,
              },
            );
          const jar = yield* Ref.make(initialJar);
          const http = client.pipe(HttpClient.withCookiesRef(jar));
          return {
            cookies: Ref.get(jar).pipe(
              Effect.map((cookies) =>
                Redacted.make(
                  Object.values(cookies.cookies).map((cookie) => ({
                    name: cookie.name,
                    value: cookie.valueEncoded,
                    domain: cookie.options?.domain ?? new URL(origin).hostname,
                    path: cookie.options?.path ?? "/",
                    httpOnly: cookie.options?.httpOnly ?? true,
                    secure: cookie.options?.secure ?? origin.startsWith("https:"),
                    sameSite:
                      cookie.options?.sameSite === "strict"
                        ? ("Strict" as const)
                        : cookie.options?.sameSite === "none"
                          ? ("None" as const)
                          : ("Lax" as const),
                    expires: cookie.options?.expires?.getTime()
                      ? cookie.options.expires.getTime() / 1000
                      : -1,
                  })),
                ),
              ),
            ),
            send: (
              method: Method,
              path: string,
              data?: unknown,
              headers: Record<string, string> = {},
            ) =>
              Effect.scoped(
                Effect.gen(function* () {
                  // Relative product URLs only. Never forward an actor's cookies to another origin.
                  const url = new URL(path, origin);
                  if (url.origin !== origin)
                    return yield* new RequestFailed({
                      method,
                      path: "cross-origin request rejected",
                      reason: "origin",
                    });
                  let request = HttpClientRequest.make(method)(url, { headers });
                  if (data !== undefined)
                    request = yield* HttpClientRequest.bodyJson(request, data);
                  const response = yield* http.execute(request);
                  const text = yield* response.text;
                  const parsed = text.length
                    ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text)
                    : null;
                  return { status: response.status, body: parsed };
                }),
              ).pipe(
                Effect.provideService(HttpClient.TracerPropagationEnabled, false),
                Effect.timeout("60 seconds"),
                Effect.mapError((cause) =>
                  Schema.is(RequestFailed)(cause)
                    ? cause
                    : new RequestFailed({
                        method,
                        path: new URL(path, origin).pathname,
                        reason: Cause.isTimeoutError(cause) ? "timeout" : "request",
                        cause: Redacted.make(cause),
                      }),
                ),
              ),
          } satisfies Session;
        });
      return {
        session,
        request: (actor, method, path, data, headers = {}) =>
          actor.send(method, path, data, { origin, ...headers }),
      } satisfies Sessions;
    }),
  );
}
/** Case-scoped HTTP evidence decorates the injected session client. */
export class Api extends Context.Service<Api, Sessions>()("e2e/Api") {
  static readonly layer = Layer.effect(
    Api,
    Effect.gen(function* () {
      const target = yield* Target,
        evidence = yield* Evidence,
        clients = yield* SessionClients;
      const origin = target.metadata.origin;
      return Api.of({
        session: clients.session,
        request: (actor, method, path, data, headers = {}) =>
          Effect.gen(function* () {
            const traceId = randomBytes(16).toString("hex"),
              spanId = randomBytes(8).toString("hex");
            const start = yield* Clock.currentTimeMillis;
            const response = yield* actor.send(method, path, data, {
              origin,
              ...headers,
              traceparent: `00-${traceId}-${spanId}-01`,
            });
            const end = yield* Clock.currentTimeMillis;
            yield* evidence.request(
              {
                method,
                path: new URL(path, origin).pathname,
                status: response.status,
                durationMs: end - start,
                traceId,
              },
              {
                traceId,
                spanId,
                name: `${method} ${new URL(path, origin).pathname}`,
                kind: 3,
                startTimeUnixNano: String(BigInt(start) * 1000000n),
                endTimeUnixNano: String(BigInt(end) * 1000000n),
                status: { code: response.status >= 400 ? 2 : 1 },
              },
            );
            return response;
          }),
      });
    }),
  );
}
