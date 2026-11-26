import { APIError, isAPIError } from "better-auth/api";
import { Cause, Effect, Exit, Schema } from "effect";

export const authCall = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => (isAPIError(error) ? error : new APIError("SERVICE_UNAVAILABLE")),
  });
export const runAuth = <A>(effect: Effect.Effect<A, APIError>) =>
  Effect.runPromiseExit(effect).then(
    Exit.match({
      onSuccess: (value) => value,
      onFailure: (cause) => {
        throw Cause.squash(cause);
      },
    }),
  );
export const parse = <A>(schema: Schema.Decoder<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new APIError("BAD_REQUEST")),
  );
