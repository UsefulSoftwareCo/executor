import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option, Schema } from "effect";
import type { HttpServerResponse } from "effect/http";

const RequestNetwork = Schema.Struct({
  asn: Schema.optionalKey(Schema.Number),
  asOrganization: Schema.optionalKey(Schema.String),
  country: Schema.optionalKey(Schema.String),
});

const organizationLength = 128;

export const clientNetworkAttributes = (cf: unknown): Record<string, string | number> => {
  const network = Schema.decodeUnknownOption(RequestNetwork)(cf);
  if (Option.isNone(network)) return {};
  const { asn, asOrganization, country } = network.value;
  return {
    ...(country === undefined || !/^[A-Z0-9]{2}$/u.test(country)
      ? {}
      : { "geo.country.iso_code": country }),
    ...(asn === undefined || !Number.isSafeInteger(asn) ? {} : { "cloudflare.asn": asn }),
    ...(asOrganization === undefined || asOrganization === ""
      ? {}
      : { "cloudflare.as_organization": asOrganization.slice(0, organizationLength) }),
  };
};

export const recordClientNetwork = <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const request = yield* Effect.serviceOption(Cloudflare.Workers.Request);
    if (Option.isSome(request)) {
      const attributes = clientNetworkAttributes(Reflect.get(request.value, "cf"));
      if (Object.keys(attributes).length > 0) yield* Effect.annotateCurrentSpan(attributes);
    }
    return yield* handler;
  });
