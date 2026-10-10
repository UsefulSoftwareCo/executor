/** The Promise boundary between Better Auth plugin callbacks and Effect programs. */
import { APIError, isAPIError } from "better-auth/api";
import { Cause, Effect, Exit, Schema } from "effect";

/** Preserve provider failures and translate storage outages without exposing tokens or SQL. */
export const authCall = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => (isAPIError(error) ? error : new APIError("SERVICE_UNAVAILABLE")),
  });
/** Promise boundary for Better Auth plugin callbacks. */
export const runAuth = <A>(effect: Effect.Effect<A, APIError>) =>
  Effect.runPromiseExit(effect).then(
    Exit.match({
      onSuccess: (value) => value,
      onFailure: (cause) => {
        throw Cause.squash(cause);
      },
    }),
  );
/** Decode a request or stored value; anything malformed is a bad request. */
export const parse = <A>(schema: Schema.Decoder<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new APIError("BAD_REQUEST")),
  );
