import { Schema } from "effect";

export const desktopSessionPath = "/api/auth/desktop/session";
export const desktopAccountPath = "/api/auth/desktop/account";
export const desktopSessionLinkSeconds = 60;

export const desktopLinkHeader = "x-executor-desktop-link";
export const desktopLinkHeaderValue = "1";

export const desktopLinkCookieName = (origin: string) =>
  new URL(origin).protocol === "https:" ? "__Host-executor-desktop-link" : "executor-desktop-link";

const accountScope =
  "A redeemed link signs the browser in with a dashboard session that the server records against the desktop's grant and pins to the organization the person consented the desktop to: every request it makes for another organization is refused, and its organization list holds only that one. Revoking the desktop sign-in, under Connected agents or by deleting its consent, ends every session its links signed in and stops it minting new ones; a link redeemed while the grant is revoked signs no one in. One desktop grant mints at most 20 links and reads its account at most 20 times a minute.";

export const desktopSessionLinkDescription = [
  "Mint a one-use link, valid for at most 60 seconds, that signs a browser window of the Executor desktop app in. Only a desktop OAuth token (resource `<api origin>/api/desktop`, scope `desktop`) may call this.",
  "Before calling, the desktop generates a random `verifier` of at least 32 bytes, encoded as unpadded base64url (43 to 128 characters), and sends `binding`, the lowercase hex SHA-256 of the verifier's ASCII text. `returnTo` is optional, defaults to `/`, and must already be a normalized path on this Executor outside `/api`.",
  "Before opening the returned `url`, the desktop sets the binding cookie in its own Electron session partition, the one the window that opens the link uses: value the verifier, `Path=/`, no `Domain`, `SameSite=Lax`, `HttpOnly`, an expiry no later than `expiresAt`. When the dashboard origin is https the cookie is `__Host-executor-desktop-link` and `Secure`. A browser stores a `Secure` cookie only for https, so on a self-hosted Executor served over plain http the cookie is `executor-desktop-link`, without `Secure`. Then it opens `url` as a top-level navigation in that partition, sending the request header `X-Executor-Desktop-Link: 1`.",
  accountScope,
].join("\n\n");

export const desktopSessionDescription = [
  "Redeem a desktop session link. The first request that names a valid, unexpired code consumes the link, whatever happens next.",
  "The browser is signed in only when the request carries the binding cookie whose SHA-256 matches the minted `binding`, carries `X-Executor-Desktop-Link: 1` and is not a `Sec-Fetch-Site: cross-site` request. A page can't add that header to a navigation it starts, so the header proves the desktop opened the link itself, over plain http too, where browsers send no `Sec-Fetch-Site`; the cookie is then deleted and the response redirects to `returnTo`. Every refusal redirects to `/login`, so a link opened in any other browser or reached from a page, as a login-CSRF lure would be, even one that planted the binding cookie, signs no one in and can never be used again. When the server cannot read or write its sign-in records it answers 503 with an error page instead.",
  accountScope,
].join("\n\n");

export const desktopAccountDescription =
  "Read whom a desktop OAuth token (resource `<api origin>/api/desktop`, scope `desktop`) signs in: the user's ID and email, and the organization the person chose on the consent page, by ID, slug and name. The desktop keys the account with it, names its windows after the organization, and calls the organization's API with the ID.";

export const DesktopAccount = Schema.Struct({
  user: Schema.Struct({ id: Schema.String, email: Schema.String }),
  organization: Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String }),
});

export const DesktopReturnPath = Schema.String.check(
  Schema.isPattern(/^\/(?!\/)[^\\]*$/u),
  Schema.isMaxLength(2048),
).pipe(Schema.brand("DesktopReturnPath"));
export type DesktopReturnPath = typeof DesktopReturnPath.Type;

export const DesktopLinkBinding = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

export const DesktopLinkVerifier = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{43,128}$/u),
);

export const DesktopSessionLinkRequest = Schema.Struct({
  binding: DesktopLinkBinding,
  returnTo: Schema.optionalKey(Schema.String),
});
