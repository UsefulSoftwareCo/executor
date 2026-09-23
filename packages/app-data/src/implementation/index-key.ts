/** Order-preserving scalar tuples. SQLite BLOB ordering supplies bounded prefix/range scans. */
import { Effect } from "effect";
import { AppDatabaseError, defaultDatabaseLimits, type Scalar } from "../contracts/database.ts";

/** Compare UTF-8 strings, booleans and finite doubles consistently, with absence before present values. */
export const encodeIndexKey = (
  values: readonly (Scalar | null)[],
  maximum = defaultDatabaseLimits.indexBytes,
) =>
  Effect.try({
    try: () => {
      const bytes = [1];
      for (const value of values) {
        if (value === null) bytes.push(1);
        else if (typeof value === "boolean") bytes.push(value ? 0x11 : 0x10);
        else if (typeof value === "string") {
          if (
            [...value].some((character) => {
              const code = character.codePointAt(0);
              return code !== undefined && code >= 0xd800 && code <= 0xdfff;
            })
          )
            throw new Error("Invalid string");
          bytes.push(0x20);
          for (const byte of new TextEncoder().encode(value)) {
            bytes.push(byte);
            if (byte === 0) bytes.push(0xff);
          }
          bytes.push(0, 0);
        } else {
          if (!Number.isFinite(value)) throw new Error("Invalid number");
          const view = new DataView(new ArrayBuffer(8));
          view.setFloat64(0, value === 0 ? 0 : value, false);
          const encoded = new Uint8Array(view.buffer);
          if (value < 0) for (const [i, byte] of encoded.entries()) encoded[i] = 0xff ^ byte;
          else view.setUint8(0, view.getUint8(0) ^ 0x80);
          bytes.push(0x30, ...encoded);
        }
        if (bytes.length > maximum) throw new Error("Index key too long");
      }
      return Uint8Array.from(bytes);
    },
    catch: () => new AppDatabaseError({ reason: "value" }),
  });

/** Exclusive upper bound for all tuples beginning with this prefix. */
export const prefixEnd = (prefix: Uint8Array): Uint8Array | undefined => {
  const result = prefix.slice();
  for (let i = result.length - 1; i >= 0; i--) {
    const byte = result[i];
    if (byte !== undefined && byte < 255) {
      result[i] = byte + 1;
      return result.slice(0, i + 1);
    }
  }
  return undefined;
};
