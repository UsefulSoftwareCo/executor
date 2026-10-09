/** Stable SHA-256 fingerprints, so names and keys never carry the raw values they identify. */
import { Effect } from "effect";
import { Base64Url } from "effect/encoding";
import { AppDatabaseError } from "../contracts/database.ts";

export const fingerprint = (crypto: Crypto, value: string) =>
  Effect.tryPromise({
    try: async () =>
      Base64Url.encode(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
      ),
    catch: () => new AppDatabaseError({ reason: "storage" }),
  });
