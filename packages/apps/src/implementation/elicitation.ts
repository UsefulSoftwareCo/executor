/** Validate both sides of a tool's form and bind delivery to its invocation lifetime. */
import { Effect, Schema } from "effect";
import {
  ElicitationFailed,
  ElicitationResponse,
  FormElicitation,
  type ElicitationHandler,
  type Elicit,
} from "../contracts/elicitation.ts";
import { toPromise } from "./authoring.ts";
import { jsonSchemaDecoder } from "./schema.ts";

/** Parse a form and retain its response parser, so invalid answers can be rejected before consuming a host continuation. */
export const prepareElicitation = (input: unknown) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(FormElicitation)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new ElicitationFailed({ reason: "invalid-request" })));
    const content = yield* jsonSchemaDecoder(request.requestedSchema).pipe(
      Effect.mapError(() => new ElicitationFailed({ reason: "invalid-request" })),
    );
    const respond = (input: unknown) =>
      Effect.gen(function* () {
        const response = yield* Schema.decodeUnknownEffect(ElicitationResponse)(input).pipe(
          Effect.catchTag("SchemaError", () =>
            Effect.fail(new ElicitationFailed({ reason: "invalid-response" })),
          ),
        );
        if (response.action === "accept") {
          // MCP permits omitted content for an empty form. Required fields still fail validation.
          const fields = response.content === undefined ? {} : response.content;
          yield* Schema.decodeUnknownEffect(content)(fields).pipe(
            Effect.mapError(() => new ElicitationFailed({ reason: "invalid-response" })),
          );
          return { ...response, content: fields };
        }
        return response;
      });
    return { request, respond };
  });

/** Bind a validated interaction to the live invocation; transport adapters share its form parser. */
export const makeElicit = (handler: ElicitationHandler | undefined, signal: AbortSignal): Elicit =>
  toPromise(
    (input: FormElicitation) =>
      Effect.gen(function* () {
        if (handler === undefined) return yield* new ElicitationFailed({ reason: "unavailable" });
        const form = yield* prepareElicitation(input);
        return yield* handler(form.request, signal).pipe(Effect.flatMap(form.respond));
      }),
    signal,
  );
