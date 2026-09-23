/** Authenticated, opaque continuation tokens tied to one installation, schema and query plan. */
import { Effect, Encoding, Schema } from "effect";
import { AppDatabaseError, defaultDatabaseRuntimeLimits } from "../contracts/database.ts";

const Payload = Schema.Struct({
  version: Schema.Literal(1),
  query: Schema.String,
  key: Schema.String,
});
/** Stable SHA-256 fingerprints contain no raw query arguments in logs or metadata keys. */
export const fingerprint = (crypto: Crypto, value: string) =>
  Effect.tryPromise({
    try: async () =>
      Encoding.encodeBase64Url(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
      ),
    catch: () => new AppDatabaseError({ reason: "storage" }),
  });

/** Capture a per-database key. Nonces are fresh, and malformed/tampered/cross-query cursors fail closed. */
export const cursorCodec = (crypto: Crypto, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const key = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey("raw", new Uint8Array(bytes), "AES-GCM", false, [
          "encrypt",
          "decrypt",
        ]),
      catch: () => new AppDatabaseError({ reason: "storage" }),
    });
    return {
      encode: (query: string, position: Uint8Array) =>
        Effect.tryPromise({
          try: async () => {
            const nonce = crypto.getRandomValues(new Uint8Array(12));
            const plaintext = new TextEncoder().encode(
              JSON.stringify({ version: 1, query, key: Encoding.encodeBase64Url(position) }),
            );
            const ciphertext = new Uint8Array(
              await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext),
            );
            const token = new Uint8Array(nonce.length + ciphertext.length);
            token.set(nonce);
            token.set(ciphertext, nonce.length);
            return Encoding.encodeBase64Url(token);
          },
          catch: () => new AppDatabaseError({ reason: "cursor" }),
        }),
      decode: (query: string, token: string) =>
        Effect.gen(function* () {
          if (token.length > defaultDatabaseRuntimeLimits.maxCursorChars)
            return yield* new AppDatabaseError({ reason: "cursor" });
          const encoded = yield* Effect.fromResult(Encoding.decodeBase64Url(token));
          if (encoded.length < 28) return yield* new AppDatabaseError({ reason: "cursor" });
          const plain = yield* Effect.tryPromise(() =>
            crypto.subtle.decrypt(
              { name: "AES-GCM", iv: new Uint8Array(encoded.slice(0, 12)) },
              key,
              new Uint8Array(encoded.slice(12)),
            ),
          );
          const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Payload))(
            new TextDecoder().decode(plain),
          );
          if (payload.query !== query) return yield* new AppDatabaseError({ reason: "cursor" });
          return yield* Effect.fromResult(Encoding.decodeBase64Url(payload.key));
        }).pipe(Effect.mapError(() => new AppDatabaseError({ reason: "cursor" }))),
    };
  });
