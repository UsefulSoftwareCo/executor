/** RFC 8628 device authorization: what the verification page and the CLI share with the server. */
import { Schema } from "effect";

export const deviceVerificationPath = "/device";

/**
 * User codes use consonants only (RFC 8628 section 6.1): no vowels to spell words, and nothing
 * that reads as a digit. Eight of them give about 34 bits, shown as two groups of four.
 */
export const userCodeAlphabet = "BCDFGHJKLMNPQRSTVWXZ";
export const userCodeLength = 8;

export const normalizeUserCode = (input: string): string | undefined => {
  const letters = input.toUpperCase().replace(/[\s-]/gu, "");
  return letters.length === userCodeLength &&
    [...letters].every((letter) => userCodeAlphabet.includes(letter))
    ? letters
    : undefined;
};

export const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export const DeviceRequestView = Schema.Struct({
  clientId: Schema.NonEmptyString,
  resource: Schema.NonEmptyString,
  scopes: Schema.Array(Schema.String),
});
export type DeviceRequestView = typeof DeviceRequestView.Type;

export const DeviceDecision = Schema.Struct({ status: Schema.Literals(["approved", "denied"]) });
export type DeviceDecision = typeof DeviceDecision.Type;
