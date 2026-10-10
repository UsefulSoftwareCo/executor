/**
 * Register an `HttpApi` together with its batch route. Each read in a batch names an endpoint of
 * the API; the host runs the route `HttpApiBuilder` registered for it, which decodes the read with
 * the endpoint's schemas, applies its group and endpoint middleware, calls its handler and encodes
 * its success or error with the endpoint's schemas. Router middleware the host applies to the API,
 * such as its per-request services, applies to the batch route in the same way.
 *
 * The batch request is the only identity: a read carries no headers, so authentication,
 * authorization and organization membership are those of the request that sent the batch.
 */
import { ByteSize, Effect, Layer, Option, Schema, Scope, Stream } from "effect";
import { HttpApi, HttpApiBuilder, type HttpApiGroup } from "effect/http-api";
import {
  Headers,
  HttpIncomingMessage,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
  HttpTraceContext,
  UrlParams,
} from "effect/http";
import {
  Batch,
  BatchAnswer,
  batchable,
  dashboardBatchPath,
  type BatchRead,
} from "../contracts/batch.ts";

/** The route `HttpApiBuilder` registered for one batchable endpoint. */
interface Target {
  readonly route: HttpRouter.Route<unknown, unknown>;
  /**
   * SAFETY: `HttpApiBuilder` types registered routes loosely. A route encodes every failure of
   * its endpoint as a response and only dies otherwise. A group layer declares its handlers'
   * requirements as router requests, which the host provides to every route of this API, the
   * batch route included; the batch route runs these handlers inside its own request.
   */
  readonly handler: Effect.Effect<HttpServerResponse.HttpServerResponse>;
}

const targetKey = (group: string, endpoint: string) => `${group}\u0000${endpoint}`;

/**
 * Index the routes `HttpApiBuilder` registered by endpoint. Effect does not expose a registered
 * handler by name, so the routes are captured as the builder adds them and matched to endpoints by
 * method and path, which identify a route uniquely within one router.
 */
const indexTargets = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  routes: ReadonlyArray<HttpRouter.Route<unknown, unknown>>,
) => {
  const targets = new Map<string, Target>();
  const missing: Array<string> = [];
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ group, endpoint }) => {
      if (!batchable(endpoint)) return;
      const route = routes.find(
        (candidate) => candidate.method === endpoint.method && candidate.path === endpoint.path,
      );
      if (route === undefined) missing.push(`${group.identifier}.${endpoint.identifier}`);
      else
        targets.set(targetKey(group.identifier, endpoint.identifier), {
          route,
          // SAFETY: see `Target.handler`.
          handler: route.handler as Effect.Effect<HttpServerResponse.HttpServerResponse>,
        });
    },
  });
  return missing.length === 0
    ? Effect.succeed(targets)
    : Effect.die(
        new Error(`Batchable endpoints without a registered route: ${missing.join(", ")}`),
      );
};

/**
 * Only this dashboard's own pages may send a batch. The body is JSON, which another site cannot
 * send without a preflight. The browser compares the page's origin with the URL it sends the batch
 * to and reports the result in `Sec-Fetch-Site`, which no page can set, so when it is present it
 * decides. The URL this server sees is not enough on its own: behind a proxy that ends TLS it is
 * `http://` while the page is `https://`, unless `X-Forwarded-Proto` reaches this server, which the
 * self-host image's host never forwards. Browsers send no `Sec-Fetch-Site` to plain `http://` hosts
 * other than loopback, and older browsers never send it; then the page's origin, which the browser
 * names on every `POST`, must be the URL's.
 */
const sameOrigin = (request: HttpServerRequest.HttpServerRequest, url: URL) =>
  (request.headers["sec-fetch-site"] === undefined
    ? request.headers.origin === url.origin
    : request.headers["sec-fetch-site"] === "same-origin") &&
  request.headers["content-type"]?.split(";")[0]?.trim() === "application/json";

/**
 * The read as a `GET` of its own URL with the batch request's headers and client address, for
 * middleware and handlers that read the request. Its path and query come from the read.
 */
const readRequest = (
  batch: HttpServerRequest.HttpServerRequest,
  origin: URL,
  route: HttpRouter.Route<unknown, unknown>,
  read: BatchRead,
) => {
  const url = new URL(
    route.path.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(read.params[name] ?? "")),
    origin,
  );
  url.search = UrlParams.toString(read.query);
  return HttpServerRequest.fromWeb(
    new Request(url, { method: "GET", headers: Object.entries(batch.headers) }),
  ).modify({ remoteAddress: batch.remoteAddress });
};

const decoder = new TextDecoder();

/** JSON and text bodies are UTF-8, which a JSON string carries as is. */
const textual = (contentType: string) =>
  /^(application\/([\w.+-]*\+)?json|text\/)/i.test(contentType);

/**
 * The answer as the endpoint encoded it. Batchable endpoints answer with one buffered body; a
 * response a batch cannot carry, a stream or a cookie, means an endpoint broke that rule.
 */
const answerOf = (read: BatchRead, response: HttpServerResponse.HttpServerResponse) => {
  const body = response.body;
  const carried =
    response.headers["set-cookie"] === undefined &&
    Object.keys(response.cookies.cookies).length === 0;
  if (carried && body._tag === "Empty")
    return Effect.succeed<BatchAnswer>({ id: read.id, status: response.status });
  if (carried && body._tag === "Uint8Array")
    return Effect.succeed<BatchAnswer>(
      textual(body.contentType)
        ? {
            id: read.id,
            status: response.status,
            contentType: body.contentType,
            text: decoder.decode(body.body),
          }
        : { id: read.id, status: response.status, contentType: body.contentType, bytes: body.body },
    );
  return Effect.logError("A batched read answered with a response a batch cannot carry").pipe(
    Effect.annotateLogs({ group: read.group, endpoint: read.endpoint, body: body._tag }),
    Effect.as<BatchAnswer>({ id: read.id, status: 500 }),
  );
};

/**
 * Run one read through its endpoint's route, under the batch request's identity. Like a request
 * of its own, the read has its own scope, so request-scoped resources such as its database client
 * are its own and are released once it has answered, without holding back its answer.
 */
const answer = (
  batch: HttpServerRequest.HttpServerRequest,
  scope: Scope.Scope,
  origin: URL,
  read: BatchRead,
  target: Target,
) =>
  Effect.flatMap(Scope.fork(scope), (own) =>
    target.handler.pipe(
      Effect.provideService(Scope.Scope, own),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        readRequest(batch, origin, target.route, read),
      ),
      Effect.provideService(HttpRouter.RouteContext, { params: read.params, route: target.route }),
      Effect.provideService(HttpServerRequest.ParsedSearchParams, read.query),
      // As the router does for a request of its own: a defect answers as a server error.
      Effect.catchCause((cause) =>
        Effect.map(HttpServerError.causeResponse(cause), ([response]) => response),
      ),
      Effect.flatMap((response) => answerOf(read, response)),
      Effect.withSpan("dashboard.batch.read", {
        attributes: {
          "http.route": target.route.path,
          "executor.batch.read": `${read.group}.${read.endpoint}`,
        },
      }),
      (effect) => {
        const parent = HttpTraceContext.fromHeaders(
          Headers.fromInput(
            read.traceparent === undefined ? {} : { traceparent: read.traceparent },
          ),
        );
        return Option.isSome(parent) ? Effect.withParentSpan(effect, parent.value) : effect;
      },
      Effect.onExit((exit) => Effect.forkIn(Scope.close(own, exit), scope)),
    ),
  );

const encodeAnswer = Schema.encodeSync(Schema.fromJsonString(BatchAnswer));
const encoder = new TextEncoder();

const serveBatch = (targets: ReadonlyMap<string, Target>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const origin = HttpServerRequest.toURL(request);
    if (Option.isNone(origin) || !sameOrigin(request, origin.value))
      return HttpServerResponse.empty({ status: 403 });
    const batch = yield* HttpServerRequest.schemaBodyJson(Batch).pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(64)),
      Effect.option,
    );
    if (Option.isNone(batch)) return HttpServerResponse.empty({ status: 400 });
    const reads = batch.value.reads.flatMap((read) => {
      const target = targets.get(targetKey(read.group, read.endpoint));
      return target === undefined ? [] : [{ read, target }];
    });
    // Unknown and unbatchable endpoints refuse the whole batch: the browser never sends them.
    if (reads.length !== batch.value.reads.length) return HttpServerResponse.empty({ status: 400 });
    const scope = yield* Scope.Scope;
    const context = yield* Effect.context<never>();
    const answers = Stream.fromIterable(reads).pipe(
      Stream.mapEffect(({ read, target }) => answer(request, scope, origin.value, read, target), {
        concurrency: "unbounded",
        unordered: true,
      }),
      Stream.map((answer) => encoder.encode(`${encodeAnswer(answer)}\n`)),
      Stream.provideContext(context),
    );
    return HttpServerResponse.stream(answers, {
      contentType: "application/x-ndjson",
      headers: { "cache-control": "private, no-store" },
    });
  });

/**
 * `HttpApiBuilder.layer(api)` plus the batch route for its batchable endpoints. Provide it the
 * same group handlers and router middleware as the API alone.
 */
export const layerWithBatches = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
) =>
  HttpRouter.use(
    Effect.fnUntraced(function* (router) {
      const registered: Array<HttpRouter.Route<unknown, unknown>> = [];
      const recording = HttpRouter.HttpRouter.of({
        ...router,
        addAll: (routes) => {
          registered.push(...routes);
          return router.addAll(routes);
        },
      });
      yield* Layer.build(HttpApiBuilder.layer(api)).pipe(
        Effect.provideService(HttpRouter.HttpRouter, recording),
      );
      yield* router.add(
        "POST",
        dashboardBatchPath,
        serveBatch(yield* indexTargets(api, registered)),
      );
    }),
  );
