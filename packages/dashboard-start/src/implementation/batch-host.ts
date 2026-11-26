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

interface Target {
  readonly route: HttpRouter.Route<unknown, unknown>;
  readonly handler: Effect.Effect<HttpServerResponse.HttpServerResponse>;
}

const targetKey = (group: string, endpoint: string) => `${group}\u0000${endpoint}`;

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

const textual = (contentType: string) =>
  /^(application\/([\w.+-]*\+)?json|text\/)/i.test(contentType);

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

const recordAnswer = ({ status }: BatchAnswer) =>
  Effect.annotateCurrentSpan(
    status >= 500
      ? { "http.response.status_code": status, "executor.outcome": "failed" }
      : { "http.response.status_code": status },
  );

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
      Effect.catchCause((cause) =>
        Effect.map(HttpServerError.causeResponse(cause), ([response]) => response),
      ),
      Effect.flatMap((response) => answerOf(read, response)),
      Effect.tap(recordAnswer),
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
