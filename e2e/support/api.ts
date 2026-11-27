import { appOriginHttpClient } from "./app-origin-tls.ts";
import { Cause, Clock, Context, Effect, Layer, Redacted, Ref, Schema } from "effect";
import { Cookies, HttpClient, HttpClientRequest } from "effect/http";
import { randomBytes } from "node:crypto";
import { Evidence } from "./evidence.ts";
import { indented, keptCauseText, reveal, secret } from "./failure-text.ts";
import { Target, withCause, type Response } from "./platform.ts";
import {
  CallFailed,
  decodeFailure,
  readResponse,
  RequestFailure,
  requestFailureText,
  signatureText,
} from "./request-failure.ts";
import { isMcpPath, targetHosts } from "./role-hosts.ts";

import { BrowserCookies } from "../sdk/contracts.ts";
export { BrowserCookies } from "../sdk/contracts.ts";
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface Session {
  readonly cookies: Effect.Effect<Redacted.Redacted<BrowserCookies>>;
  readonly send: (
    method: Method,
    path: string,
    data?: unknown,
    headers?: Record<string, string>,
  ) => Effect.Effect<Response, RequestFailed>;
}
export const currentClient = { "executor-wire-revision": "1" } as const;
export const releasedClient = { "executor-wire-revision": "0" } as const;
export class RequestFailed extends Schema.TaggedError<RequestFailed>()("RequestFailed", {
  method: Schema.String,
  path: Schema.String,
  status: Schema.optional(Schema.Number),
  response: Schema.optional(
    Schema.Struct({
      contentType: Schema.String,
      characters: Schema.Number,
      path: Schema.String,
    }),
  ),
  reason: Schema.Literals(["origin", "timeout", "request", "deployment"]),
  cause: Schema.optional(Schema.Redacted(Schema.Unknown)),
  failure: Schema.optional(RequestFailure),
}) {
  override get message() {
    const detail = keptCauseText(this);
    const failure = this.failure === undefined ? "" : `: ${requestFailureText(this.failure)}`;
    return `${signatureText(this.failure)}${this.method} ${this.path} ${this.status === undefined ? `failed (${this.reason}) before a JSON response was read` : `returned HTTP ${this.status} without a JSON response`}${this.response ? ` (${this.response.contentType}, ${this.response.characters} characters, final path ${this.response.path})` : ""}${failure}${detail === undefined ? "" : `\n  ${indented(detail)}`}`;
  }
}
export const body = <A>(schema: Schema.ConstraintDecoder<A, never>, response: Response) =>
  Schema.decodeUnknownEffect(schema)(response.body).pipe(
    Effect.tapError(() =>
      Effect.logError("Response body did not match the expected shape", {
        status: response.status,
        body: JSON.stringify(response.body).slice(0, 2000),
      }),
    ),
  );
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
export class SessionClients extends Context.Service<SessionClients, Sessions>()(
  "e2e/SessionClients",
) {
  static readonly layer = Layer.effect(
    SessionClients,
    Effect.gen(function* () {
      const target = yield* Target,
        client =
          target.tlsCertificate === undefined
            ? yield* HttpClient.HttpClient
            : yield* appOriginHttpClient(target.tlsCertificate);
      const origin = targetHosts(target).browser;
      const deployment = targetHosts(target).deployment;
      const session = (initial?: Redacted.Redacted<BrowserCookies>) =>
        Effect.gen(function* () {
          const jar = yield* Ref.make<ReadonlyArray<Cookies.Cookie>>(
            (initial ? reveal(initial) : []).map((cookie) =>
              Cookies.makeCookieUnsafe(cookie.name, decodeURIComponent(cookie.value), {
                domain: new URL(origin).hostname,
                path: cookie.path,
                httpOnly: cookie.httpOnly,
                secure: cookie.secure,
              }),
            ),
          );
          const http = client.pipe(HttpClient.withCookiesRef(jar));
          return {
            cookies: Ref.get(jar).pipe(
              Effect.map((cookies) =>
                secret(
                  cookies.map((cookie) => ({
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
                  const base = isMcpPath(new URL(path, origin).pathname) ? deployment : origin;
                  const url = new URL(path, base);
                  if (url.origin !== base)
                    return yield* new RequestFailed({
                      method,
                      path: "cross-origin request rejected",
                      reason: "origin",
                    });
                  let request = HttpClientRequest.make(method)(url, {
                    headers: { ...currentClient, ...headers },
                  });
                  if (data !== undefined)
                    request = yield* HttpClientRequest.bodyJson(request, data);
                  const { response, text, started } = yield* readResponse(
                    http.execute(request),
                    "60 seconds",
                  );
                  const deploying =
                    response.status === 200 && text === "Alchemy worker is being deployed...";
                  const parsed = text.length
                    ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
                        text,
                      ).pipe(
                        Effect.catch((cause) =>
                          decodeFailure(
                            response.status,
                            started,
                            cause,
                            response.headers,
                            text,
                          ).pipe(
                            Effect.flatMap((failure) =>
                              Effect.fail(
                                new RequestFailed({
                                  method,
                                  path: url.pathname,
                                  status: response.status,
                                  response: {
                                    contentType: response.headers["content-type"] ?? "absent",
                                    characters: text.length,
                                    path: new URL(response.url || url.href).pathname,
                                  },
                                  reason: deploying ? "deployment" : "request",
                                  failure,
                                }),
                              ),
                            ),
                          ),
                        ),
                      )
                    : null;
                  return { status: response.status, body: parsed };
                }),
              ).pipe(
                Effect.provideService(HttpClient.TracerPropagationEnabled, false),
                Effect.mapError((cause) =>
                  Schema.is(RequestFailed)(cause)
                    ? cause
                    : cause instanceof CallFailed
                      ? withCause(
                          new RequestFailed({
                            method,
                            path: new URL(path, origin).pathname,
                            reason: cause.failure.stage === "timeout" ? "timeout" : "request",
                            failure: cause.failure,
                            cause: cause.cause,
                          }),
                        )
                      : withCause(
                          new RequestFailed({
                            method,
                            path: new URL(path, origin).pathname,
                            reason: Cause.isTimeoutError(cause) ? "timeout" : "request",
                            cause: Redacted.make(cause),
                          }),
                        ),
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
export class Api extends Context.Service<Api, Sessions>()("e2e/Api") {
  static readonly layer = Layer.effect(
    Api,
    Effect.gen(function* () {
      const target = yield* Target,
        evidence = yield* Evidence,
        clients = yield* SessionClients;
      const origin = targetHosts(target).browser;
      return Api.of({
        session: clients.session,
        request: (actor, method, path, data, headers = {}) =>
          Effect.gen(function* () {
            const traceId = headers.traceparent?.split("-")[1] ?? randomBytes(16).toString("hex"),
              spanId = randomBytes(8).toString("hex");
            yield* evidence.sending({
              method,
              path: new URL(path, origin).pathname,
              traceId,
              spanId,
            });
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
