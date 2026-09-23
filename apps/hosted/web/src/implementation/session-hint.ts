import { BrowserSession } from "@executor-js/hosted-server/browser/contracts";
import { OrganizationId } from "@executor-js/hosted-server/organization";
import { Option, Schema } from "effect";
import { Cookies } from "effect/unstable/http";

const Hint = Schema.Struct({
  session: BrowserSession,
  expiresAt: Schema.Number,
  lastOrganization: Schema.optionalKey(OrganizationId),
});
const lifetime = 7 * 24 * 60 * 60;
const maximumLength = 3500;

// Cookies do not distinguish ports. Keep local cloud and self-host hints separate.
const cookieName = () => `executor-ui${location.port === "" ? "" : `-${location.port}`}`;
const attributes = () => `Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;

/** Remove display metadata after sign-out or a confirmed missing session. */
export const clearSessionHint = (): void => {
  document.cookie = `${cookieName()}=; Max-Age=0; ${attributes()}`;
};

const readHint = (): Option.Option<typeof Hint.Type> => {
  const value = Cookies.parseHeader(document.cookie)[cookieName()];
  if (value === undefined) return Option.none();
  const hint = Schema.decodeUnknownOption(Schema.fromJsonString(Hint))(value);
  if (
    value.length > maximumLength ||
    Option.isNone(hint) ||
    hint.value.session === null ||
    hint.value.expiresAt <= Date.now()
  ) {
    return Option.none();
  }
  return hint;
};

/** Parse an untrusted display hint; it never authorizes an API request. */
export const readSessionHint = (): Option.Option<typeof BrowserSession.Type> => {
  const hint = readHint();
  if (Option.isNone(hint)) clearSessionHint();
  return Option.map(hint, (value) => value.session);
};

const writeHint = (hint: typeof Hint.Type): void => {
  const value = encodeURIComponent(JSON.stringify(hint));
  if (value.length > maximumLength) return clearSessionHint();
  document.cookie = `${cookieName()}=${value}; Max-Age=${lifetime}; ${attributes()}`;
};

/** Save only the display fields projected from a successful live session response. */
export const writeSessionHint = (session: typeof BrowserSession.Type): void => {
  if (session === null) return clearSessionHint();
  const previous = readLastOrganization(session.user.id);
  writeHint({
    session,
    expiresAt: Date.now() + lifetime * 1000,
    ...(previous === undefined ? {} : { lastOrganization: previous }),
  });
};

/** Read this user's last destination by stable ID, never as API authority or a slug guess. */
export const readLastOrganization = (userId: string): OrganizationId | undefined => {
  const hint = readHint();
  return Option.isSome(hint) && hint.value.session?.user.id === userId
    ? hint.value.lastOrganization
    : undefined;
};

/** Record a foreground route only after the host has confirmed the user's access. */
export const rememberOrganization = (userId: string, organization: OrganizationId): void => {
  const hint = readHint();
  if (
    Option.isSome(hint) &&
    hint.value.session?.user.id === userId &&
    hint.value.lastOrganization !== organization
  )
    writeHint({ ...hint.value, lastOrganization: organization });
};

/** Forget a rejected destination without removing a newer choice made in another tab. */
export const forgetOrganization = (userId: string, organization: OrganizationId): void => {
  const hint = readHint();
  if (
    Option.isSome(hint) &&
    hint.value.session?.user.id === userId &&
    hint.value.lastOrganization === organization
  ) {
    writeHint({ session: hint.value.session, expiresAt: hint.value.expiresAt });
  }
};
