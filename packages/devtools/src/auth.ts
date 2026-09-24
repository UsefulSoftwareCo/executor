import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/client";
import { Effect, Layer, Schema } from "effect";
import { Atom } from "effect/unstable/reactivity";

const runtime = Atom.runtime(Layer.empty);
class OperatorRequestFailed extends Schema.TaggedError<OperatorRequestFailed>()(
  "OperatorRequestFailed",
  {},
) {}
const authRequest = <A>(
  run: (options: {
    signal: AbortSignal;
  }) => Promise<{ data: A; error: null } | { data: null; error: { status: number } }>,
) =>
  Effect.tryPromise({
    try: (signal) => run({ signal }),
    catch: () => new OperatorRequestFailed(),
  }).pipe(
    Effect.flatMap((result) =>
      result.error === null
        ? Effect.succeed(result.data)
        : Effect.fail(new OperatorRequestFailed()),
    ),
  );
const client = createAuthClient({ plugins: [adminClient()] });
const Users = Schema.Struct({
  users: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      email: Schema.String,
      role: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  total: Schema.Number,
});
/** Bounded directory search, authorized by Better Auth on every request. */
export const operatorUsersAtom = Atom.family((search: string) =>
  runtime.atom(
    authRequest((options) =>
      client.admin.listUsers(
        {
          query: {
            limit: 20,
            sortBy: "createdAt",
            sortDirection: "desc",
            ...(search
              ? ({ searchField: "email", searchOperator: "contains", searchValue: search } as const)
              : {}),
          },
        },
        options,
      ),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Users))),
  ),
);
/** Native impersonation preserves the original admin session in an HttpOnly cookie. */
export const impersonateAtom = runtime.fn((userId: string) =>
  authRequest((options) => client.admin.impersonateUser({ userId }, options)).pipe(Effect.asVoid),
);
/** Restore the original session and revoke the impersonated session. */
export const stopImpersonatingAtom = runtime.fn(() =>
  authRequest((options) => client.admin.stopImpersonating({}, options)).pipe(Effect.asVoid),
);
