import { Schema } from "effect";

/** Collision-free scenario identity; safe for paths, slugs and synthetic email addresses. */
export const ScenarioId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));

/** Serialized browser cookies are always wrapped as redacted values outside their driver. */
export const BrowserCookies = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    value: Schema.String,
    domain: Schema.String,
    path: Schema.String,
    httpOnly: Schema.Boolean,
    secure: Schema.Boolean,
    sameSite: Schema.Literals(["Strict", "Lax", "None"]),
    expires: Schema.Number,
  }),
);
export type BrowserCookies = typeof BrowserCookies.Type;
/** A generated capability for one runner-owned fixture process. */
export const FixtureControl = Schema.Struct({
  origin: Schema.String.check(
    Schema.makeFilter((value) => {
      const url = URL.parse(value);
      return (
        url !== null &&
        url.origin === value &&
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1"
      );
    }),
  ),
  token: Schema.RedactedFromValue(Schema.NonEmptyString),
});
/** A synthetic identity and its private, expiring browser session. */
export const FixtureActor = Schema.Struct({
  userId: Schema.String,
  email: Schema.String,
  name: Schema.String,
  expiresAt: Schema.String,
  cookies: BrowserCookies,
});
/** Each scenario owns an independent organization and three distinct identities. */
export const FixtureActors = Schema.Struct({
  id: Schema.String,
  origin: Schema.String,
  organization: Schema.Struct({ id: Schema.String, slug: Schema.String }),
  actors: Schema.Struct({ owner: FixtureActor, admin: FixtureActor, member: FixtureActor }),
});
