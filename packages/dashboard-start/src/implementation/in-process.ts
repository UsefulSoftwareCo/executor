import { Config, Context, Effect, Option } from "effect";
import { inProcessOrigin } from "../contracts/api.ts";
import type { DocumentApi } from "../contracts/document.ts";
import { requestDisplayFormat, timeZoneCookie } from "@executor-js/ui/contracts/display";
import {
  Cookies,
  HttpEffect,
  HttpRouter,
  HttpServerRequest,
  HttpTraceContext,
  type HttpServerResponse,
} from "effect/http";

export class HostPipeline extends Context.Service<
  HostPipeline,
  (request: Request) => Promise<Response>
>()("@executor-js/dashboard-start/HostPipeline") {}

type WebHandler = (request: Request) => Promise<Response>;

export const InProcessReadFixture = Context.Reference<(pipeline: WebHandler) => WebHandler>(
  "@executor-js/dashboard-start/InProcessReadFixture",
  { defaultValue: () => (pipeline) => pipeline },
);

export const withHostPipeline = <E, R>(
  serve: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, Exclude<R, HostPipeline>> =>
  Effect.flatMap(Effect.context<Exclude<R, HostPipeline>>(), (context) => {
    const handler = Context.get(context, InProcessReadFixture)((request) => pipeline(request));
    const self = Effect.provideService(serve, HostPipeline, handler);
    const pipeline = HttpEffect.toWebHandlerWith<
      Exclude<R, HostPipeline>,
      Exclude<R, HostPipeline>,
      never
    >(context)(self);
    return self;
  });

export const hostPipelineLayer = HttpRouter.middleware<{ provides: HostPipeline }>()(
  (serve) => withHostPipeline(serve),
  { global: true },
);

const traceHeaders = [
  "traceparent",
  "tracestate",
  "b3",
  "x-b3-traceid",
  "x-b3-spanid",
  "x-b3-sampled",
];

const forwarded = [
  "host",
  "cookie",
  "user-agent",
  "accept-language",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-executor-client-ip",
  "cf-connecting-ip",
  "cf-ipcountry",
] as const;

export const inProcessApi = Effect.gen(function* () {
  const handler = yield* HostPipeline;
  const document = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(document);
  if (Option.isNone(url)) return yield* Effect.die("Document request has no URL");
  const origin = url.value.origin;
  const cookieOrigin = yield* Config.String("BETTER_AUTH_URL").pipe(
    Config.withDefault(origin),
    Effect.orDie,
  );
  const identity = new Headers();
  for (const name of forwarded) {
    const value = document.headers[name];
    if (value !== undefined) identity.set(name, value);
  }
  const trace = HttpTraceContext.toHeaders(yield* Effect.currentSpan.pipe(Effect.orDie));
  const cookies: Array<string> = [];
  let sealed = false;
  const apiFetch: typeof globalThis.fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input), origin);
    const request = new Request(input instanceof Request ? input : target, init);
    if (
      (target.origin !== origin && target.origin !== inProcessOrigin) ||
      !["GET", "HEAD"].includes(request.method)
    )
      throw new TypeError(
        `Server rendering can only read this host's API: ${request.method} ${target.href}`,
      );
    const headers = new Headers(request.headers);
    identity.forEach((value, name) => {
      if (!headers.has(name)) headers.set(name, value);
    });
    for (const name of traceHeaders) headers.delete(name);
    for (const [name, value] of Object.entries(trace)) headers.set(name, value);
    const response = await handler(
      new Request(new URL(target.pathname + target.search, origin), {
        method: request.method,
        headers,
        signal: request.signal,
      }),
    );
    if (!sealed) cookies.push(...response.headers.getSetCookie());
    return response;
  };
  return {
    document: {
      apiFetch,
      path: url.value.pathname + url.value.search,
      display: requestDisplayFormat({
        acceptLanguage: document.headers["accept-language"],
        timeZone: Cookies.parseHeader(document.headers.cookie ?? "")[
          timeZoneCookie(new URL(cookieOrigin).protocol === "https:")
        ],
      }),
    } satisfies DocumentApi,
    seal: () => {
      sealed = true;
      return cookies;
    },
  };
});
