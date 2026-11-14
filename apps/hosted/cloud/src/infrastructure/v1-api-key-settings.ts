/**
 * Where Cloud checks Executor v1's WorkOS API keys (`implementation/v1-captured-api-keys.ts`):
 * the WorkOS emulator where the deployment has emulators, else v1's WorkOS with
 * `V1_WORKOS_API_KEY`. Without either, unknown keys are refused as before. Removed with that key
 * once validated traffic is gone (`notes/v1-shutdown.md`).
 */
import { Config, Effect, Option, Redacted } from "effect";
import type { V1WorkOSKeys } from "../implementation/v1-captured-api-keys.ts";
import { cloudEmulators } from "./emulators.ts";

/** v1's production WorkOS API key in the Agents vault ("Work OS API Key Prod"). A reference only. */
export const v1WorkosKeyReference = "op://Agents/svyzpaqa3tfi27ckajfyjwp66a/credential";

/** What to set when production has no v1 WorkOS key, which the WorkOS API key check reads. */
export const missingV1WorkosKey =
  "V1_WORKOS_API_KEY is required on the production stage (v2): add " +
  `\`V1_WORKOS_API_KEY=${v1WorkosKeyReference}\` to .env.ci.op and run \`bun run ci:deploy\`, ` +
  "which stores it in the GitHub production environment that `.github/workflows/deploy.yml` " +
  "passes to the Worker.";

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
