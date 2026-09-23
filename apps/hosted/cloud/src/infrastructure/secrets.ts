/** Test stages mint their signing and encryption secrets once; Alchemy state keeps them stable. */
import { Random } from "alchemy";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { testStage } from "./stage.ts";

const SigningSecret = Schema.Redacted(Schema.String.check(Schema.isMinLength(32)));
/** AES-GCM credentials need exactly 32 raw bytes, hex encoded. */
const EncryptionKey = Schema.Redacted(
  Schema.String.check(
    Schema.makeFilter((value) => /^[0-9a-f]{64}$/i.test(value), {
      message: "EXECUTOR_ENCRYPTION_KEY must be 32 hex-encoded bytes",
    }),
  ),
);

export interface CloudSecrets {
  /** Better Auth signing secret. Read it inside an invocation, never at initialization. */
  readonly authSecret: Effect.Effect<Redacted.Redacted<string>>;
  /** Key for stored provider credentials. */
  readonly encryptionKey: Effect.Effect<Redacted.Redacted<string>>;
}

/**
 * Configured stages read both secrets from their environment at deploy time.
 * Test stages own `Random` resources instead; Alchemy binds each value into the Worker
 * and the accessor reads it back at runtime, so nothing is copied into a vault.
 */
export const cloudSecrets = Effect.gen(function* () {
  if (Option.isNone(yield* testStage)) {
    const authSecret = yield* Config.Redacted("BETTER_AUTH_SECRET").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SigningSecret)),
    );
    const encryptionKey = yield* Config.Redacted("EXECUTOR_ENCRYPTION_KEY").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(EncryptionKey)),
    );
    return {
      authSecret: Effect.succeed(authSecret),
      encryptionKey: Effect.succeed(encryptionKey),
    } satisfies CloudSecrets;
  }
  const authSecret = yield* Random("AuthSecret");
  const encryptionKey = yield* Random("EncryptionKey", { bytes: 32 });
  return {
    authSecret: yield* authSecret.text,
    encryptionKey: yield* encryptionKey.text,
  } satisfies CloudSecrets;
});
