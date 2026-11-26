import { Cause, Match, Option } from "effect";
import type { Atom, AsyncResult } from "effect/reactivity";
import { acknowledgedQuery } from "@executor-js/ui/contracts/mutations";
import type { HostedError } from "./errors.ts";
const denied = Match.type<HostedError>().pipe(
  Match.tags({
    OrganizationForbidden: () => true,
    Unauthorized: () => true,
    Forbidden: () => true,
    AppNotFound: () => true,
    AppAccessDenied: () => true,
    AccountNotFound: () => true,
    ScheduleNotFound: () => true,
  }),
  Match.orElse(() => false),
);
export const retainProtectedFailure = (cause: Cause.Cause<HostedError>) => {
  const error = Cause.findErrorOption(cause);
  return Option.isNone(error) || !denied(error.value);
};
export const protectedQuery = <A, E extends HostedError>(
  source: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) => acknowledgedQuery(source, retainProtectedFailure);
