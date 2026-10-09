import { Effect, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { acknowledge, acknowledgedQuery } from "@executor-js/ui/contracts/mutations";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { observeBrowserUsage } from "./product-analytics.ts";
import { accountOperations, authCallOptions, sessionAtom, type AuthCallOptions } from "./auth.ts";
import { BrowserAtoms } from "./telemetry.ts";

/** Safe account errors; raw auth errors are not rendered. */
export class AccountFailed extends Schema.TaggedError<AccountFailed>()("AccountFailed", {
  message: Schema.String,
}) {}

const request = <A>(
  operation: string,
  run: (
    options: AuthCallOptions,
  ) => Promise<
    { data: A; error: null } | { data: null; error: { status: number; code?: string | undefined } }
  >,
) =>
  Effect.flatMap(authCallOptions, (options) =>
    Effect.tryPromise({
      try: () => run(options),
      catch: () => new AccountFailed({ message: "Cannot reach the server. Try again." }),
    }),
  ).pipe(
    Effect.flatMap((result) =>
      result.error === null
        ? Effect.succeed(result.data)
        : Effect.fail(
            new AccountFailed({
              message:
                result.error.code === "INVALID_PASSWORD"
                  ? "Your current password is incorrect. Try again."
                  : result.error.code === "PASSWORD_TOO_SHORT"
                    ? "Choose a longer password."
                    : result.error.code === "PASSWORD_TOO_LONG"
                      ? "Choose a shorter password."
                      : result.error.status === 401
                        ? "Your session has ended. Sign in again."
                        : "Unable to update your account. Check the details and try again.",
            }),
          ),
    ),
    (work) => observeBrowserUsage("account", operation, work),
    Effect.withSpan(`ui.account.${operation}`),
  );

/** Rename, then show the new name everywhere the session is displayed. */
export const renameUserAtom = BrowserAtoms.fn((name: string, get) =>
  request("rename", (options) => accountOperations(options).rename(name)).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        acknowledge(get, sessionAtom, (current) =>
          current === null ? current : { ...current, user: { ...current.user, name } },
        ),
      ),
    ),
    Effect.asVoid,
  ),
);

/** A signed-in browser or client; the token is kept only to address a revocation. */
export const SessionSummary = Schema.Struct({
  id: Schema.String,
  token: Schema.RedactedFromValue(Schema.NonEmptyString),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
  expiresAt: Schema.Date,
  ipAddress: Schema.optional(Schema.NullOr(Schema.String)),
  userAgent: Schema.optional(Schema.NullOr(Schema.String)),
});
export type SessionSummary = typeof SessionSummary.Type;
const CurrentSession = Schema.NullOr(
  Schema.Struct({ session: Schema.Struct({ id: Schema.String }) }),
);
export const Sessions = Schema.Struct({
  current: Schema.NullOr(Schema.String),
  sessions: Schema.Array(SessionSummary),
});
export type Sessions = typeof Sessions.Type;

/** Every active session of the signed-in user, newest first, with this browser's marked. */
const sessionsQuery = BrowserAtoms.atom((get) => {
  const session = get(sessionAtom);
  if (!AsyncResult.isSuccess(session) || session.value === null)
    return Effect.succeed<Sessions>({ current: null, sessions: [] });
  return Effect.all(
    [
      request("current", (options) => accountOperations(options).current()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CurrentSession)),
      ),
      request("sessions", (options) => accountOperations(options).sessions()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionSummary))),
      ),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(([current, sessions]): Sessions => ({
      current: current?.session.id ?? null,
      sessions: [...sessions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    })),
    Effect.withSpan("ui.account.sessions"),
  );
}).pipe(revalidated);
export const sessionsAtom = acknowledgedQuery(sessionsQuery);

/** Sign one other device out; its row leaves the list once the server confirms. */
export const revokeSessionAtom = Atom.family((sessionId: string) =>
  BrowserAtoms.fn((token: string, get) =>
    request("revokeSession", (options) => accountOperations(options).revokeSession(token)).pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          acknowledge(get, sessionsAtom, (current) => ({
            ...current,
            sessions: current.sessions.filter((session) => session.id !== sessionId),
          })),
        ),
      ),
      Effect.asVoid,
    ),
  ),
);

/** Keep this browser signed in and end every other session. */
export const revokeOtherSessionsAtom = BrowserAtoms.fn((_: void, get) =>
  request("revokeOtherSessions", (options) =>
    accountOperations(options).revokeOtherSessions(),
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        acknowledge(get, sessionsAtom, (state) => ({
          ...state,
          sessions: state.sessions.filter((session) => session.id === state.current),
        })),
      ),
    ),
    Effect.asVoid,
  ),
);

/** Password sign-in hosts only; the server verifies the current password. */
export const changePasswordAtom = BrowserAtoms.fn(
  (input: { readonly currentPassword: string; readonly newPassword: string }) =>
    request("changePassword", (options) => accountOperations(options).changePassword(input)).pipe(
      Effect.asVoid,
    ),
);
