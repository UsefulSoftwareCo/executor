import { Cause, Match, Option } from "effect";
import type { DashboardError } from "./errors.ts";
export {
  accountNeedsSignIn,
  appToolReadiness,
  selectedIds,
  accountSelectionIssues,
  displayDate,
  type AccountSelectionIssue,
} from "@executor-js/ui/contracts/dashboard";
/** A late account change needs the same setup action as one visible in the inventory. */
export function accountSetupFailure(cause: Cause.Cause<DashboardError>) {
  return Option.flatMap(Cause.findErrorOption(cause), (error) =>
    Match.value(error).pipe(
      Match.tag("AccountNotFound", "AccountRequired", "AccountSelectionInvalid", (error) =>
        Option.some(error),
      ),
      Match.orElse(() => Option.none()),
    ),
  );
}
