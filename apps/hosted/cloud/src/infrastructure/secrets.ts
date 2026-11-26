import { Random } from "alchemy";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { testStage } from "./stage.ts";

const SigningSecret = Schema.Redacted(Schema.String.check(Schema.isMinLength(32)));
const EncryptionKey = Schema.Redacted(
  Schema.String.check(
    Schema.makeFilter((value) => /^[0-9a-f]{64}$/i.test(value), {
      message: "EXECUTOR_ENCRYPTION_KEY must be 32 hex-encoded bytes",
    }),
  ),
);

export interface CloudSecrets {
  readonly authSecret: Effect.Effect<Redacted.Redacted<string>>;
  readonly encryptionKey: Effect.Effect<Redacted.Redacted<string>>;
}

export const cloudEncryptionKey = Effect.gen(function* () {
  if (Option.isNone(yield* testStage)) {
    const encryptionKey = yield* Config.Redacted("EXECUTOR_ENCRYPTION_KEY").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(EncryptionKey)),
    );
    return Effect.succeed(encryptionKey);
  }
  return yield* (yield* Random("EncryptionKey", { bytes: 32 })).text;
});

export const cloudSecrets = Effect.gen(function* () {
  const encryptionKey = yield* cloudEncryptionKey;
  if (Option.isNone(yield* testStage)) {
    const authSecret = yield* Config.Redacted("BETTER_AUTH_SECRET").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SigningSecret)),
    );
    return { authSecret: Effect.succeed(authSecret), encryptionKey } satisfies CloudSecrets;
  }
  const authSecret = yield* Random("AuthSecret");
  return { authSecret: yield* authSecret.text, encryptionKey } satisfies CloudSecrets;
});

export const v1McpForwardSecretName = "V1_MCP_FORWARD_SECRET";

export const v1SessionHandoffSecretName = "V1_SESSION_HANDOFF_SECRET";

const v1SharedSecret = (name: string) =>
  Effect.gen(function* () {
    const secret = (yield* Config.Redacted(name).pipe(Config.option)).pipe(
      Option.filter((value) => Redacted.value(value) !== ""),
    );
    if (
      Option.isSome(secret) &&
      Option.isNone(Schema.decodeUnknownOption(SigningSecret)(secret.value))
    )
      return yield* Effect.die(new Error(`${name} must be at least 32 characters`));
    return secret;
  });

export const v1McpForwardSecret = v1SharedSecret(v1McpForwardSecretName);

export const v1SessionHandoffSecret = v1SharedSecret(v1SessionHandoffSecretName);
