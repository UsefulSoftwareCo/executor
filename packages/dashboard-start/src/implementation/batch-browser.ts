import { Effect, Exit, Option, Request, RequestResolver, Result, Schema, Stream } from "effect";
import { HttpApi, type HttpApiGroup } from "effect/http-api";
import {
  FindMyWay,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpTraceContext,
  Url,
} from "effect/http";
import { isConnectionFailure } from "@executor-js/utils/connection-failure";
import {
  BatchAnswer,
  batchable,
  dashboardBatchPath,
  maxBatchReads,
  type BatchRead,
} from "../contracts/batch.ts";

const batchWindow = "4 millis";

class Read extends Request.Class<
  {
    readonly read: Omit<BatchRead, "id">;
    readonly request: HttpClientRequest.HttpClientRequest;
    readonly client: HttpClient.HttpClient;
  },
  Option.Option<HttpClientResponse.HttpClientResponse>,
  HttpClientError.HttpClientError
> {}

const unanswered = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      description: "The batch ended without answering this read",
    }),
  });

const nullBodyStatuses = new Set([204, 205, 304]);

const bodyOf = (answer: BatchAnswer) =>
  nullBodyStatuses.has(answer.status) ? null : (answer.text ?? answer.bytes?.slice() ?? null);

const responseOf = (request: HttpClientRequest.HttpClientRequest, answer: BatchAnswer) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(bodyOf(answer), {
      status: answer.status,
      headers: answer.contentType === undefined ? {} : { "content-type": answer.contentType },
    }),
  );

const decodeAnswer = Schema.decodeUnknownEffect(Schema.fromJsonString(BatchAnswer));

const send = (entries: ReadonlyArray<Request.Entry<Read>>) =>
  Effect.gen(function* () {
    const [first] = entries;
    if (first === undefined) return;
    if (entries.length === 1) {
      first.completeUnsafe(Exit.succeed(Option.none()));
      return;
    }
    const waiting = new Map(entries.map((entry, id) => [id, entry]));
    let lost: unknown;
    const failed = (request: HttpClientRequest.HttpClientRequest) =>
      lost === undefined
        ? unanswered(request)
        : new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: lost }),
          });
    yield* first.request.client
      .execute(
        HttpClientRequest.post(dashboardBatchPath).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            reads: entries.map((entry, id) => ({ id, ...entry.request.read })),
          }),
        ),
      )
      .pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (isConnectionFailure(error)) lost = error.reason.cause;
          }),
        ),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) =>
          response.stream.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.mapEffect((line) => decodeAnswer(line)),
            Stream.runForEach((answer) =>
              Effect.sync(() => {
                const entry = waiting.get(answer.id);
                if (entry === undefined) return;
                waiting.delete(answer.id);
                entry.completeUnsafe(
                  Exit.succeed(Option.some(responseOf(entry.request.request, answer))),
                );
              }),
            ),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            for (const entry of waiting.values())
              entry.completeUnsafe(Exit.fail(failed(entry.request.request)));
          }),
        ),
        Effect.exit,
      );
  });

const routable = (path: string): path is `/${string}` => path.startsWith("/");

const reads = RequestResolver.make<Read>(send).pipe(
  RequestResolver.setDelay(batchWindow),
  RequestResolver.batchN(maxBatchReads),
);

export const batchReads = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
): ((client: HttpClient.HttpClient) => HttpClient.HttpClient) => {
  if (typeof window === "undefined") return (client) => client;
  const endpoints = FindMyWay.make<Pick<BatchRead, "group" | "endpoint">>();
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ group, endpoint }) => {
      if (batchable(endpoint) && routable(endpoint.path))
        endpoints.on("GET", endpoint.path, {
          group: group.identifier,
          endpoint: endpoint.identifier,
        });
    },
  });
  const readOf = (request: HttpClientRequest.HttpClientRequest) => {
    if (request.method !== "GET") return undefined;
    const url = Url.make(request.url, request.urlParams, undefined);
    if (Result.isFailure(url) || url.success.origin !== window.location.origin) return undefined;
    const found = endpoints.find("GET", url.success.pathname + url.success.search);
    if (found === undefined) return undefined;
    const params: Record<string, string> = {};
    for (const [name, value] of Object.entries(found.params))
      if (value !== undefined) params[name] = value;
    return { ...found.handler, params, query: found.searchParams };
  };
  return (client) =>
    HttpClient.transform(client, (direct, request) => {
      const read = readOf(request);
      if (read === undefined) return direct;
      return Effect.flatMap(Effect.option(Effect.currentSpan), (span) =>
        Effect.request(
          new Read({
            read: Option.isSome(span)
              ? { ...read, traceparent: HttpTraceContext.toHeaders(span.value)["traceparent"] }
              : read,
            request,
            client,
          }),
          reads,
        ).pipe(Effect.flatMap(Option.match({ onNone: () => direct, onSome: Effect.succeed }))),
      );
    });
};
