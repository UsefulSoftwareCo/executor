/** Effect-native decoding; fetch adaptation happens at the author boundary. */
import { Effect, type Schema } from "effect";
import { type JsonResponse, ResponseDecodeError, ResponseStatusError } from "../contracts/http.ts";
import { parse } from "./schema.ts";

/** Reject unsuccessful status before reading the body, then parse without leaking its contents. */
export const decodeJson = <T>(
  response: JsonResponse,
  schema: Schema.Decoder<T>,
): Effect.Effect<T, ResponseStatusError | ResponseDecodeError> =>
  Effect.gen(function* () {
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(new ResponseStatusError({ status: response.status }));
    }
    const body = yield* response.json();
    return yield* parse(schema, body).pipe(Effect.mapError(() => new ResponseDecodeError()));
  });
