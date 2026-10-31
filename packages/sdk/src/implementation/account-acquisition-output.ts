import { Effect, Schema } from "effect";
import {
  AccountCheckResult,
  HostOperationFailed,
  HostOutputInvalid,
  type InteractiveStart,
  InteractiveStatus,
  ProviderError,
} from "apps/contracts";
import {
  privateAccountDisplay,
  privateAccountStrings,
} from "@executor-js/utils/account-display-privacy";
import { privateAccountCheck } from "./account-status-output.ts";
import type { AccountId } from "../contracts/shared.ts";

/** The session stays private; only the instructions may cross the caller boundary. */
export const acquisitionStartOutput = (value: InteractiveStart, reference?: string) =>
  Effect.gen(function* () {
    const { session, ...instructions } = value;
    if (!privateAccountStrings(instructions, {}, reference)) return yield* new HostOutputInvalid();
    return { session, ...instructions };
  });

/** Unsafe identity text falls back to the host's account name without losing the acquired credential. */
export const acquisitionStatusOutput = (value: unknown, reference?: string) =>
  Effect.gen(function* () {
    const result = yield* Schema.decodeUnknownEffect(InteractiveStatus)(value).pipe(
      Effect.mapError(() => new HostOutputInvalid()),
    );
    if (result.state === "failed" && !privateAccountStrings(result, {}, reference))
      return { state: "failed" as const, message: "The account sign-in could not finish." };
    if (result.state !== "connected" || result.accountInfo === undefined) return result;
    const { accountInfo, ...connected } = result;
    const acquired = privateAccountDisplay({ accountInfo }, {}, result.ref);
    const shown =
      acquired === undefined ? undefined : privateAccountDisplay(acquired, {}, reference);
    return shown === undefined ? connected : { ...connected, accountInfo: shown.accountInfo };
  });

/** Validate the check before any public result or saved receipt can contain the reference. */
export const acquisitionCheckOutput = (value: unknown, reference: string) =>
  Effect.gen(function* () {
    if (value === undefined) return undefined;
    const health = yield* Schema.decodeUnknownEffect(AccountCheckResult)(value).pipe(
      Effect.mapError(() => new HostOutputInvalid()),
    );
    return yield* privateAccountCheck(health, {}, reference);
  });

/** Only bounded public errors cross this boundary; causes and the opaque reference stay private. */
export const acquisitionCallbackError = (error: unknown, account: AccountId, reference: string) => {
  if (Schema.is(HostOutputInvalid)(error)) return new HostOutputInvalid();
  if (Schema.is(ProviderError)(error)) {
    const shown = {
      reason: error.reason,
      status: error.status,
      phase: error.phase,
      upstream: error.upstream,
    };
    return privateAccountStrings(shown, {}, reference)
      ? new ProviderError({ ...shown, accountId: account })
      : new ProviderError({ reason: error.reason, status: error.status, accountId: account });
  }
  if (Schema.is(HostOperationFailed)(error)) {
    const shown = {
      ...(error.source === undefined ? {} : { source: error.source }),
      ...(error.errorName === undefined ? {} : { errorName: error.errorName }),
      ...(error.code === undefined ? {} : { code: error.code }),
      message: error.message,
      ...(error.fields === undefined ? {} : { fields: error.fields }),
    };
    if (privateAccountStrings(shown, {}, reference)) return new HostOperationFailed(shown);
  }
  return new HostOperationFailed({});
};
