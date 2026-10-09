/**
 * Server rendering reads the host's own API without a network hop. Each read runs the host's
 * complete request pipeline, so authentication, authorization, request telemetry and error
 * reporting are the same as for the browser's HTTP request.
 */
import { Context, Effect, Option } from "effect";
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

/** The host's request pipeline as a Web handler bound to the current outer request's services. */
export class HostPipeline extends Context.Service<
  HostPipeline,
  (request: Request) => Promise<Response>
>()("@executor-js/dashboard-start/HostPipeline") {}

type WebHandler = (request: Request) => Promise<Response>;

/**
 * Stands between a document's in-process reads and the host pipeline. Product hosts never provide
 * it, so reads reach the pipeline unchanged. A test host composition provides it to give a read an
 * answer that no request from outside can provoke, such as an access check that fails while the
 * page's own reads succeed. One instance wraps the reads of one document.
 */
export const InProcessReadFixture = Context.Reference<(pipeline: WebHandler) => WebHandler>(
  "@executor-js/dashboard-start/InProcessReadFixture",
  { defaultValue: () => (pipeline) => pipeline },
);

/**
 * Make `serve` available to the documents it renders. The handler captures the services of the
 * request that reached the host, including its trace span, so each in-process read is recorded
 * as a child of the document request.
 */
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

/** Router-level form for hosts whose outer request pipeline is the router itself. */
export const hostPipelineLayer = HttpRouter.middleware<{ provides: HostPipeline }>()(
  (serve) => withHostPipeline(serve),
  { global: true },
);

/** Trace propagation headers a read may carry from the client span that made it. */
const traceHeaders = [
  "traceparent",
  "tracestate",
  "b3",
  "x-b3-traceid",
  "x-b3-spanid",
  "x-b3-sampled",
];

/** Headers that identify the browser to the API, exactly as its own request would. */
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

/**
 * The in-process API for the current document request. Responses received before `seal` is
 * called may renew cookies, which the document then forwards; later ones cannot reach the browser.
 */
export const inProcessApi = Effect.gen(function* () {
  const handler = yield* HostPipeline;
  const document = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(document);
  if (Option.isNone(url)) return yield* Effect.die("Document request has no URL");
  const origin = url.value.origin;
  const identity = new Headers();
  for (const name of forwarded) {
    const value = document.headers[name];
    if (value !== undefined) identity.set(name, value);
  }
  // Reads start while the document streams, after its span has ended. Each one is recorded as a
  // child of the document span, not of the rendering client's span, which is never exported.
  const trace = HttpTraceContext.toHeaders(yield* Effect.currentSpan.pipe(Effect.orDie));
  const cookies: Array<string> = [];
  let sealed = false;
  const apiFetch: typeof globalThis.fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input), origin);
    const request = new Request(input instanceof Request ? input : target, init);
    // Rendering only reads this host. A write or another origin during rendering is a bug.
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
        timeZone: Cookies.parseHeader(document.headers.cookie ?? "")[timeZoneCookie],
      }),
    } satisfies DocumentApi,
    seal: () => {
      sealed = true;
      return cookies;
    },
  };
});
