/** RFC 8628 device authorization: what the verification page and the CLI share with the server. */
import { Schema } from "effect";

/** The dashboard page where a signed-in person enters or confirms a device's user code. */
export const deviceVerificationPath = "/device";

/**
 * User codes use consonants only (RFC 8628 section 6.1): no vowels to spell words, and nothing
 * that reads as a digit. Eight of them give about 34 bits, shown as two groups of four.
 */
export const userCodeAlphabet = "BCDFGHJKLMNPQRSTVWXZ";
export const userCodeLength = 8;

/** Accept any case and separators people type or paste; `undefined` when it cannot be a code. */
export const normalizeUserCode = (input: string): string | undefined => {
  const letters = input.toUpperCase().replace(/[\s-]/gu, "");
  return letters.length === userCodeLength &&
    [...letters].every((letter) => userCodeAlphabet.includes(letter))
    ? letters
    : undefined;
};

/** `BCDFGHJK` as `BCDF-GHJK`, the form the CLI prints and the page shows. */
export const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/**
 * A pending request as its verification page shows it. The client's name comes from its
 * registration, looked up separately, never from anything the device sent.
 */
export const DeviceRequestView = Schema.Struct({
  clientId: Schema.NonEmptyString,
  resource: Schema.NonEmptyString,
  scopes: Schema.Array(Schema.String),
});
export type DeviceRequestView = typeof DeviceRequestView.Type;

/** What a person decided for a device request. */
export const DeviceDecision = Schema.Struct({ status: Schema.Literals(["approved", "denied"]) });
export type DeviceDecision = typeof DeviceDecision.Type;
