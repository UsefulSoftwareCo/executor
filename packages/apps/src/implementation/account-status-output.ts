/** Refuse credential-bearing display data before it leaves a provider or app-owned check. */
import { Effect, Redacted, Schema } from "effect";
import { AccountCheckResult } from "../contracts/provider.ts";
import { HostOutputInvalid, type HostContext } from "../contracts/host.ts";
import { privateAccountDisplay } from "@executor-js/utils/account-display-privacy";

export const accountCheckOutput = (value: unknown, context: HostContext, ref?: string) =>
  Effect.gen(function* () {
    const result = yield* Schema.decodeUnknownEffect(AccountCheckResult)(value).pipe(
      Effect.mapError(() => new HostOutputInvalid()),
    );
    const shown = privateAccountDisplay(result, Redacted.value(context.accounts), ref);
    if (shown === undefined) return yield* new HostOutputInvalid();
    return yield* Schema.encodeEffect(AccountCheckResult)(shown).pipe(
      Effect.mapError(() => new HostOutputInvalid()),
    );
  });
