// ---------------------------------------------------------------------------
// Login state — the OAuth `state` parameter for the WorkOS login round trip.
//
// `state` exists for CSRF (the callback checks it against the wos-login-state
// cookie), and OAuth round-trips it verbatim — which makes it the natural
// carrier for `returnTo` too: base64url(JSON { nonce, returnTo }). One value,
// one cookie, and the destination is covered by the same timing-safe
// comparison that authenticates the nonce.
//
// Decoding is total: anything that isn't our encoding reads as null, because
// the callback can also be reached by WorkOS-initiated redirects whose state
// (if any) we never minted.
// ---------------------------------------------------------------------------

import { Encoding, Option, Result, Schema } from "effect";

const LoginStateSchema = Schema.Struct({
  nonce: Schema.String,
  returnTo: Schema.optional(Schema.String),
});

export type LoginState = typeof LoginStateSchema.Type;

const LoginStateFromJson = Schema.fromJsonString(LoginStateSchema);
const decodeLoginStateJson = Schema.decodeUnknownOption(LoginStateFromJson);
const encodeLoginStateJson = Schema.encodeSync(LoginStateFromJson);

export const encodeLoginState = (state: LoginState): string =>
  Encoding.encodeBase64Url(encodeLoginStateJson(state));

/** Decode a state value back; null for anything we didn't mint. */
export const decodeLoginState = (value: string | null | undefined): LoginState | null => {
  if (!value) return null;
  const json = Result.getOrNull(Encoding.decodeBase64UrlString(value));
  return json === null ? null : Option.getOrNull(decodeLoginStateJson(json));
};
