/** Shared browser approval data access. Products provide the route and their page-owned Atom runtime. */
import {
  BrowserApprovalAcknowledgement,
  BrowserApprovalView,
  type ElicitationResponse,
} from "@executor-js/mcp/browser";
import { Effect, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { Atom } from "effect/unstable/reactivity";

/** Safe HTTP outcomes shared by the local and hosted browser approval endpoints. */
export class BrowserApprovalFailed extends Schema.TaggedError<BrowserApprovalFailed>()(
  "BrowserApprovalFailed",
  {
    reason: Schema.Literals([
      "unauthorized",
      "forbidden",
      "invalid-answer",
      "unavailable",
      "network",
    ]),
  },
) {}
const request = <A>(endpoint: string, schema: Schema.Decoder<A>, answer?: ElicitationResponse) =>
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
      if (response.status !== 200)
        return yield* new BrowserApprovalFailed({
          reason:
            response.status === 401
              ? "unauthorized"
              : response.status === 403
                ? "forbidden"
                : response.status === 400
                  ? "invalid-answer"
                  : response.status === 404
                    ? "unavailable"
                    : "network",
        });
      return yield* HttpClientResponse.schemaBodyJson(schema)(response);
    }),
  ).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.catchTags({
      HttpClientError: () => Effect.fail(new BrowserApprovalFailed({ reason: "network" })),
      HttpBodyError: () => Effect.fail(new BrowserApprovalFailed({ reason: "invalid-answer" })),
      SchemaError: () => Effect.fail(new BrowserApprovalFailed({ reason: "network" })),
    }),
  );

/** Construct one review and acknowledge its removal from any product-owned queue after an answer. */
export const browserApproval = (
  runtime: Atom.AtomRuntime<never>,
  endpoint: string,
  onAnswer?: (get: Atom.FnContext) => void,
) => ({
  view: runtime.atom(request(endpoint, BrowserApprovalView)),
  answer: runtime.fn((response: ElicitationResponse, get) =>
    request(endpoint, BrowserApprovalAcknowledgement, response).pipe(
      Effect.tap(() => Effect.sync(() => onAnswer?.(get))),
    ),
  ),
});
/** Each link owns its query and submission state; answers from one request cannot overwrite another. */
export const browserApprovalAtoms = (runtime: Atom.AtomRuntime<never>) =>
  Atom.family((endpoint: string) => browserApproval(runtime, endpoint));
/** Bindings for the shared review page. */
export type BrowserApprovalAtoms = ReturnType<typeof browserApproval>;
