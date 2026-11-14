/**
 * Where Cloud checks Executor v1's WorkOS API keys (`implementation/v1-captured-api-keys.ts`):
 * the WorkOS emulator where the deployment has emulators, else v1's WorkOS with
 * `V1_WORKOS_API_KEY`, the key the v1 sign-in check already holds. Without either, unknown keys
 * are refused as before. Removed with that key once validated traffic is gone
 * (`notes/v1-shutdown.md`).
 */
import { Config, Effect, Option, Redacted } from "effect";
import type { V1WorkOSKeys } from "../implementation/v1-captured-api-keys.ts";
import { cloudEmulators } from "./emulators.ts";

export const cloudV1WorkOSKeys = Effect.gen(function* () {
  const emulators = yield* cloudEmulators;
  if (Option.isSome(emulators)) {
    const workos = Redacted.value(emulators.value).workos;
    return Option.some<V1WorkOSKeys>({
      baseUrl: workos.baseUrl,
      key: Redacted.make(workos.token),
    });
  }
  // GitHub Actions passes an unset secret as an empty string, so empty means unset.
  const key = (yield* Config.Redacted("V1_WORKOS_API_KEY").pipe(Config.option)).pipe(
    Option.filter((value) => Redacted.value(value) !== ""),
  );
  return Option.map(key, (value): V1WorkOSKeys => ({
    baseUrl: "https://api.workos.com",
    key: value,
  }));
});
