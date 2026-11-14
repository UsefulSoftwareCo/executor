import { Schema } from "effect";
import { heldValue } from "../support/failure-text.ts";

/** Collision-free scenario identity; safe for paths, slugs and synthetic email addresses. */
export const ScenarioId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u));

/**
 * A team origin with which no HTTPS connection completed within preparation's wait, with what the
 * run's other origins did and what the stage's domain coordinator last recorded for it.
 */
export const OriginUnreachable = Schema.Struct({
  attempts: Schema.Number,
  waitedMs: Schema.Number,
  readyOrigins: Schema.Number,
  origins: Schema.Number,
  /** How long the slowest origin that did become ready took; null when none did. */
  slowestReadyMs: Schema.NullOr(Schema.Number),
  /** Cloudflare's label for the origin's certificate, as the coordinator last saw it. */
  certificate: Schema.optional(Schema.String),
  /** When the coordinator's status for the origin last changed (ISO 8601, UTC). */
  since: Schema.optional(Schema.String),
});

/**
 * Why an organization was not provisioned, in words: the error's tag, the request that failed and
 * where (`before response`, `response`), and the class of its transport error read from the
 * innermost causes (a TLS handshake failure, a reset, a refused connection). Built only from
 * the request's method and path template, error tags and codes, never a body or a header.
 */
export const ProvisioningFailure = Schema.Struct({
  failure: Schema.String,
  request: Schema.optional(Schema.String),
  stage: Schema.optional(Schema.String),
  transport: Schema.optional(Schema.String),
  elapsedMs: Schema.optional(Schema.Number),
});

/** Preparation failures belong to their scenario and remain native setup failures. */
export const PreparedScenarios = Schema.Record(
  Schema.NonEmptyString,
  Schema.Struct({
    id: ScenarioId,
    status: Schema.Literals(["ready", "organization_unavailable", "domain_unavailable"]),
    unreachable: Schema.optional(OriginUnreachable),
    provisioning: Schema.optional(ProvisioningFailure),
  }),
);

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
  token: heldValue(Schema.RedactedFromValue(Schema.NonEmptyString)),
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
