import { isLoopbackHostname } from "@executor-js/utils/url-policy";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { EmulatedServices } from "../contracts/emulators.ts";
import { cloudOrigin, testStage } from "./stage.ts";

/** External providers may be emulated only on loopback Cloud dev or dedicated E2E stages. */
export const cloudEmulators = Effect.gen(function* () {
  const value = yield* Config.Redacted("EXECUTOR_EMULATORS").pipe(Config.option);
  if (Option.isNone(value)) return Option.none<Redacted.Redacted<typeof EmulatedServices.Type>>();
  const stage = yield* testStage;
  const origin = new URL(yield* cloudOrigin);
  if (
    !(Option.isSome(stage) && stage.value.name.startsWith("test-e2e-")) &&
    !isLoopbackHostname(origin.hostname)
  )
    return yield* Effect.die(
      new Error("Emulators require Cloud dev or a dedicated test-e2e- stage"),
    );
  const services = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(EmulatedServices))(
    Redacted.value(value.value),
  ).pipe(Effect.mapError(() => new Error("Invalid external emulator configuration")));
  return Option.some(Redacted.make(services));
});

/** Test stages address private service instances on the shared emulator host. */
export const testStageEmulatorHost = Config.String("TEST_STAGE_EMULATOR_HOST").pipe(
  Config.withDefault("https://emulators.dev"),
);
