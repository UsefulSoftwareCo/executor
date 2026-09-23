/** Reusable AES-GCM credential encryption; the configured key stays outside the database and app runtime. */
import { CredentialsError, JsonObject } from "../contracts/shared.ts";
import type { Credentials } from "../contracts/storage.ts";
import { Effect, Encoding, Redacted, Result, Schema } from "effect";

/** Import a configured 256-bit key. Envelopes bind ciphertext to its stable resource ID. */
export const aesGcmCredentials = (
  secret: Redacted.Redacted<string>,
  crypto: Crypto,
): Effect.Effect<Credentials, CredentialsError> =>
  Effect.gen(function* () {
    const bytes = yield* Encoding.decodeHex(Redacted.value(secret)).pipe(
      Result.mapError(() => new CredentialsError()),
      Effect.fromResult,
    );
    if (bytes.length !== 32) return yield* Effect.fail(new CredentialsError());
    const key = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey("raw", Uint8Array.from(bytes), "AES-GCM", false, [
          "encrypt",
          "decrypt",
        ]),
      catch: () => new CredentialsError(),
    });
    return {
      encrypt: (account, fields) =>
        Effect.gen(function* () {
          const nonce = yield* Effect.try({
            try: () => crypto.getRandomValues(new Uint8Array(12)),
            catch: () => new CredentialsError(),
          });
          const json = yield* Schema.encodeEffect(Schema.fromJsonString(JsonObject))(
            Redacted.value(fields),
          ).pipe(Effect.mapError(() => new CredentialsError()));
          const encrypted = yield* Effect.tryPromise({
            try: () =>
              crypto.subtle.encrypt(
                { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(account) },
                key,
                new TextEncoder().encode(json),
              ),
            catch: () => new CredentialsError(),
          });
          const envelope = new Uint8Array(13 + encrypted.byteLength);
          envelope[0] = 1;
          envelope.set(nonce, 1);
          envelope.set(new Uint8Array(encrypted), 13);
          return envelope;
        }).pipe(Effect.withSpan("sdk.credentials.encrypt")),
      decrypt: (account, bytes) =>
        Effect.gen(function* () {
          const envelope = Uint8Array.from(Redacted.value(bytes));
          if (envelope[0] !== 1 || envelope.length < 29)
            return yield* Effect.fail(new CredentialsError());
          const decrypted = yield* Effect.tryPromise({
            try: () =>
              crypto.subtle.decrypt(
                {
                  name: "AES-GCM",
                  iv: envelope.slice(1, 13),
                  additionalData: new TextEncoder().encode(account),
                },
                key,
                envelope.slice(13),
              ),
            catch: () => new CredentialsError(),
          });
          return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(
            new TextDecoder().decode(decrypted),
          ).pipe(
            Effect.map(Redacted.make),
            Effect.mapError(() => new CredentialsError()),
          );
        }).pipe(Effect.withSpan("sdk.credentials.decrypt")),
    };
  });
