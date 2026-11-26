import { Schema } from "effect";
import { heldValue } from "../support/failure-text.ts";

export const ScenarioId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u));

export const OriginUnreachable = Schema.Struct({
  attempts: Schema.Number,
  waitedMs: Schema.Number,
  readyOrigins: Schema.Number,
  origins: Schema.Number,
  slowestReadyMs: Schema.NullOr(Schema.Number),
  certificate: Schema.optional(Schema.String),
  since: Schema.optional(Schema.String),
});

export const ProvisioningFailure = Schema.Struct({
  failure: Schema.String,
  request: Schema.optional(Schema.String),
  stage: Schema.optional(Schema.String),
  transport: Schema.optional(Schema.String),
  elapsedMs: Schema.optional(Schema.Number),
});

export const PreparedScenarios = Schema.Record(
  Schema.NonEmptyString,
  Schema.Struct({
    id: ScenarioId,
    status: Schema.Literals(["ready", "organization_unavailable", "domain_unavailable"]),
    unreachable: Schema.optional(OriginUnreachable),
    provisioning: Schema.optional(ProvisioningFailure),
  }),
);

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
export const FixtureActor = Schema.Struct({
  userId: Schema.String,
  email: Schema.String,
  name: Schema.String,
  expiresAt: Schema.String,
  cookies: BrowserCookies,
});
export const FixtureActors = Schema.Struct({
  id: Schema.String,
  origin: Schema.String,
  organization: Schema.Struct({ id: Schema.String, slug: Schema.String }),
  actors: Schema.Struct({ owner: FixtureActor, admin: FixtureActor, member: FixtureActor }),
});
