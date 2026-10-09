/**
 * The browser's dashboard reads that start together travel as one batch. A page starts its reads
 * when it renders; sent one request each, they spread across server isolates, and every new
 * isolate starts cold. Underneath a typed `HttpApiClient`, each read of a batchable endpoint
 * becomes a request to one resolver, which sends the reads it collects as one `POST` and answers
 * each from the streamed reply. The client still decodes each answer with its endpoint's schemas.
 */
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

/**
 * Reads that start within this window share a batch. A render starts its reads in one task; the
 * window only has to cover the tasks the atom runtime schedules them in.
 */
const batchWindow = "4 millis";

/**
 * A read's answer from its batch, or none when nothing else started with it. The caller then sends
 * the read as its own request in its own fiber, so a caller that stops waiting, such as a query
 * refreshed while its read is in flight, cancels that request. Sent by the resolver, the request
 * would outlive its caller, and its unread response would hold the connection until collected.
 */
class Read extends Request.Class<
  {
    readonly read: Omit<BatchRead, "id">;
    readonly request: HttpClientRequest.HttpClientRequest;
    /** The client the read was made with, which sends its batch. */
    readonly client: HttpClient.HttpClient;
  },
  Option.Option<HttpClientResponse.HttpClientResponse>,
  HttpClientError.HttpClientError
> {}

/** A read the batch did not answer fails as a lost request would. */
const unanswered = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      description: "The batch ended without answering this read",
    }),
  });

/** Statuses whose responses cannot carry a body, even an empty one. */
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
    // A batch that got no response fails each read it carried the same way, so each read reports
    // the lost connection instead of a reply the server cut short.
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

/** Every endpoint path is absolute; `HttpApiEndpoint` types it as any string. */
const routable = (path: string): path is `/${string}` => path.startsWith("/");

/** One resolver per page, so reads of every API client that start together share a batch. */
const reads = RequestResolver.make<Read>(send).pipe(
  RequestResolver.setDelay(batchWindow),
  RequestResolver.batchN(maxBatchReads),
);

/**
 * Send this API's batchable reads in batches. The host must serve the API with its batch route.
 * Server rendering reads the host in-process, so there it returns the client unchanged.
 */
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
  /** The endpoint a request reads, found the way the host's router finds it. */
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
