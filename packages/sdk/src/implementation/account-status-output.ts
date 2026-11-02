/** Validate display data against raw credentials before the SDK persists or returns it. */
import { Effect, Schema } from "effect";
import { AccountCheckResult, HostOutputInvalid } from "apps/contracts";
import { privateAccountDisplay } from "@executor-js/utils/account-display-privacy";

export const privateAccountCheck = (value: AccountCheckResult, accounts: unknown, ref?: string) =>
  Effect.gen(function* () {
    const shown = privateAccountDisplay(value, accounts, ref);
    if (shown === undefined) return yield* new HostOutputInvalid();
    return yield* Schema.decodeUnknownEffect(AccountCheckResult)(shown).pipe(
      Effect.mapError(() => new HostOutputInvalid()),
    );
  });
