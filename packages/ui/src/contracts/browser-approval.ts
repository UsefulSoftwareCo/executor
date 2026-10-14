/** Shared browser approval data access. Products provide the route and their page-owned Atom runtime. */
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

/**
 * Safe HTTP outcomes shared by the local and hosted browser approval endpoints. `reply-unreadable`:
 * Executor accepted an answer, which may have resumed the call, but its reply did not decode here.
 */
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
/**
 * A review can also fail with the product's own refusal. Reading it again cannot change the answer,
 * so the card shows the refusal's cause and recovery instead of offering a retry.
 */
export type BrowserApprovalFailure = BrowserApprovalFailed | ToolRunApprovalRefused;
/** Send one read or answer. Transport failures become safe outcomes; the body is decoded later. */
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
    /** The product's typed 403, kept with its cause and recovery. */
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
    // Reading again is safe. An accepted answer is not: the request may already be used.
    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(
        () =>
          new BrowserApprovalFailed({
            reason: options.answer === undefined ? "network" : "reply-unreadable",
          }),
      ),
    );
  });

/** Construct one review and acknowledge its removal from any product-owned queue after an answer. */
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
/**
 * The same review for a person's own dashboard run. Its answer carries the resumed call's outcome.
 * A request the dashboard may not review keeps the product's refusal and its recovery.
 */
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
/** Bindings for a dashboard run's review. */
export type ToolRunApprovalAtoms = ReturnType<typeof toolRunApproval>;
/** Each link owns its query and submission state; answers from one request cannot overwrite another. */
export const browserApprovalAtoms = (runtime: Atom.AtomRuntime<never>) =>
  Atom.family((endpoint: string) => browserApproval(runtime, endpoint));
/** Bindings for the shared review page. */
export type BrowserApprovalAtoms = ReturnType<typeof browserApproval>;
/** What the review card reads and answers, from either kind of review. */
export interface ReviewAtoms {
  readonly view: Atom.Atom<AsyncResult.AsyncResult<BrowserApprovalView, BrowserApprovalFailure>>;
  readonly answer: Atom.AtomResultFn<
    ElicitationResponse,
    { readonly status: BrowserApprovalAcknowledgement["status"] },
    BrowserApprovalFailure
  >;
}
