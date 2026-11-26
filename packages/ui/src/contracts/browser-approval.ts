import { dashboardHttpClient, hydratedResult, requestKey } from "./http.ts";
import {
  BrowserApprovalAcknowledgement,
  BrowserApprovalView,
  BrowserToolRunAnswerReceived,
  ToolRunApprovalRefused,
  type ElicitationResponse,
} from "@executor-js/mcp/browser";
import { Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Atom, type AsyncResult } from "effect/reactivity";

export class BrowserApprovalFailed extends Schema.TaggedError<BrowserApprovalFailed>()(
  "BrowserApprovalFailed",
  {
    reason: Schema.Literals([
      "unauthorized",
      "forbidden",
      "invalid-answer",
      "unavailable",
      "network",
      "reply-unreadable",
    ]),
  },
) {}
export type BrowserApprovalFailure = BrowserApprovalFailed | ToolRunApprovalRefused;
const send = (endpoint: string, answer: ElicitationResponse | undefined) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request =
        answer === undefined
          ? HttpClientRequest.get(endpoint)
          : yield* HttpClientRequest.post(endpoint).pipe(
              HttpClientRequest.bodyJson({ response: answer }),
            );
      const response = yield* client.execute(request);
      const body = yield* response.json.pipe(Effect.option);
      return { status: response.status, body: Option.getOrUndefined(body) };
    }),
  ).pipe(
    Effect.provide(dashboardHttpClient),
    Effect.catchTags({
      HttpClientError: () => Effect.fail(new BrowserApprovalFailed({ reason: "network" })),
      HttpBodyError: () => Effect.fail(new BrowserApprovalFailed({ reason: "invalid-answer" })),
    }),
  );
const request = <A, E = never>(
  endpoint: string,
  schema: Schema.Decoder<A>,
  options: {
    readonly answer?: ElicitationResponse;
    readonly refused?: Schema.Decoder<E>;
  } = {},
) =>
  Effect.gen(function* () {
    const { status, body } = yield* send(endpoint, options.answer);
    if (status === 403 && options.refused !== undefined) {
      const refused = Schema.decodeUnknownOption(options.refused)(body);
      if (Option.isSome(refused)) return yield* Effect.fail(refused.value);
    }
    if (status !== 200)
      return yield* new BrowserApprovalFailed({
        reason:
          status === 401
            ? "unauthorized"
            : status === 403
              ? "forbidden"
              : status === 400
                ? "invalid-answer"
                : status === 404
                  ? "unavailable"
                  : "network",
      });
    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(
        () =>
          new BrowserApprovalFailed({
            reason: options.answer === undefined ? "network" : "reply-unreadable",
          }),
      ),
    );
  });

export const browserApproval = (
  runtime: Atom.AtomRuntime<never>,
  endpoint: string,
  onAnswer?: (get: Atom.FnContext) => void,
) => ({
  view: runtime.atom(request(endpoint, BrowserApprovalView)).pipe(
    hydratedResult({
      key: `browser-approval:${requestKey(endpoint)}`,
      success: BrowserApprovalView,
      error: BrowserApprovalFailed,
    }),
  ),
  answer: runtime.fn((response: ElicitationResponse, get) =>
    request(endpoint, BrowserApprovalAcknowledgement, { answer: response }).pipe(
      Effect.tap(() => Effect.sync(() => onAnswer?.(get))),
    ),
  ),
});
export const toolRunApproval = (runtime: Atom.AtomRuntime<never>, endpoint: string) => ({
  view: runtime
    .atom(request(endpoint, BrowserApprovalView, { refused: ToolRunApprovalRefused }))
    .pipe(
      hydratedResult({
        key: `browser-approval:${requestKey(endpoint)}`,
        success: BrowserApprovalView,
        error: Schema.Union([BrowserApprovalFailed, ToolRunApprovalRefused]),
      }),
    ),
  answer: runtime.fn((response: ElicitationResponse) =>
    request(endpoint, BrowserToolRunAnswerReceived, {
      answer: response,
      refused: ToolRunApprovalRefused,
    }),
  ),
});
export type ToolRunApprovalAtoms = ReturnType<typeof toolRunApproval>;
export const browserApprovalAtoms = (runtime: Atom.AtomRuntime<never>) =>
  Atom.family((endpoint: string) => browserApproval(runtime, endpoint));
export type BrowserApprovalAtoms = ReturnType<typeof browserApproval>;
export interface ReviewAtoms {
  readonly view: Atom.Atom<AsyncResult.AsyncResult<BrowserApprovalView, BrowserApprovalFailure>>;
  readonly answer: Atom.AtomResultFn<
    ElicitationResponse,
    { readonly status: BrowserApprovalAcknowledgement["status"] },
    BrowserApprovalFailure
  >;
}
