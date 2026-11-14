/**
 * The network a request came from, on its server span. `client.address` is the address Cloudflare
 * saw (`cf-connecting-ip`), which Alchemy gives the request and Effect's server tracer records. The
 * rest comes from the request's `cf` object: its country and its autonomous system. Cloudflare sets
 * both for every request it receives from the internet, and a client cannot choose them.
 *
 * Executor's zones are on plans whose analytics do not break traffic down by address, so these
 * spans are the only record of where a request came from.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option, Schema } from "effect";
import type { HttpServerResponse } from "effect/http";

/** The fields read from `request.cf`; Cloudflare's other properties are ignored. */
const RequestNetwork = Schema.Struct({
  asn: Schema.optionalKey(Schema.Number),
  asOrganization: Schema.optionalKey(Schema.String),
  country: Schema.optionalKey(Schema.String),
});

/** An autonomous system's name, such as a hosting provider's; long ones are cut. */
const organizationLength = 128;

/**
 * The span attributes for a request's network: `geo.country.iso_code` (OpenTelemetry's name for
 * the ISO 3166-1 alpha-2 code; Cloudflare also uses `T1` for Tor and `XX` for unknown), and
 * `cloudflare.asn` and `cloudflare.as_organization`, which OpenTelemetry has no names for.
 */
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

/**
 * Record the request's network on the current span. Apply it where the handler runs in the
 * request's server span, beside `requestTiming`. It reads only the incoming request, with no I/O.
 */
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
