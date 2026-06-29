// ---------------------------------------------------------------------------
// Auth-hint cookie — the client-readable "probably signed in" signal.
//
// The session cookie itself (cloud's `wos-session`, self-host's Better Auth
// cookie) is HttpOnly, so on a fresh page load the SPA can't know it's signed
// in until `/account/me` resolves. This cookie is the non-HttpOnly companion:
// a display-only snapshot of the authenticated identity that `AuthProvider`
// writes whenever `/account/me` confirms a session and reads back at the next
// page load to render the app shell immediately, while `/account/me`
// reconciles in the background.
//
// It is a HINT, never an authority: every API call is still authenticated by
// the real session cookie server-side, and a stale or forged hint can only
// change which placeholder the user briefly sees. Keep the payload to
// display data the user already knows about themselves.
//
// The encode/decode half is pure (no DOM) so a server that wants to write or
// clear the hint (cloud's logout does) shares one encoding with the client.
// ---------------------------------------------------------------------------

import { Option, Schema } from "effect";

export const AUTH_HINT_COOKIE = "executor-auth-hint";

/** Matches the session cookie lifetime (7 days). */
export const AUTH_HINT_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

const AuthHintSchema = Schema.Struct({
  v: Schema.Literal(1),
  user: Schema.Struct({
    id: Schema.String,
    email: Schema.String,
    name: Schema.NullOr(Schema.String),
    avatarUrl: Schema.NullOr(Schema.String),
  }),
  organization: Schema.NullOr(
    Schema.Struct({ id: Schema.String, name: Schema.String, slug: Schema.String }),
  ),
});

export type AuthHint = typeof AuthHintSchema.Type;

const AuthHintFromJson = Schema.fromJsonString(AuthHintSchema);
const decodeAuthHintJson = Schema.decodeUnknownOption(AuthHintFromJson);
// The cookie value arrives percent-encoded; a truncated/corrupted one can
// make decodeURIComponent itself throw, which must read as "no hint".
const decodeUriComponentOption = Option.liftThrowable(decodeURIComponent);

const encodeAuthHintJson = Schema.encodeSync(AuthHintFromJson);

/** Encode a hint as a wire-ready cookie VALUE (URI-encoded JSON). */
export const encodeAuthHint = (hint: AuthHint): string =>
  encodeURIComponent(encodeAuthHintJson(hint));

/** Decode a cookie VALUE back into a hint; null for anything malformed. */
export const decodeAuthHint = (value: string | null | undefined): AuthHint | null => {
  if (!value) return null;
  return decodeUriComponentOption(value).pipe(Option.flatMap(decodeAuthHintJson), Option.getOrNull);
};

// ── Browser-side cookie maintenance (AuthProvider) ───────────────────────────

export const writeAuthHintCookie = (hint: AuthHint): void => {
  document.cookie = `${AUTH_HINT_COOKIE}=${encodeAuthHint(hint)}; Path=/; Max-Age=${AUTH_HINT_MAX_AGE_SECONDS}; SameSite=Lax${
    window.location.protocol === "https:" ? "; Secure" : ""
  }`;
};

export const clearAuthHintCookie = (): void => {
  document.cookie = `${AUTH_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
};

export const readAuthHintCookie = (): AuthHint | null => {
  const match = document.cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${AUTH_HINT_COOKIE}=`));
  return decodeAuthHint(match ? match.slice(AUTH_HINT_COOKIE.length + 1) : null);
};
