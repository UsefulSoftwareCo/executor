import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { OrganizationLogo } from "@executor-js/hosted-server";
import { CompanyLookup, CompanyLookupFailed, CompanyProfile } from "../contracts/onboarding.ts";

const BrandResponse = Schema.Struct({
  partial: Schema.optional(Schema.Boolean),
  brand: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        domain: Schema.String,
        title: Schema.optional(Schema.String),
        description: Schema.optional(Schema.String),
        logos: Schema.optional(
          Schema.Array(
            Schema.Struct({
              url: Schema.String,
              type: Schema.optional(Schema.String),
            }),
          ),
        ),
        colors: Schema.optional(Schema.Array(Schema.Struct({ hex: Schema.String }))),
      }),
    ),
  ),
});

/** Context.dev owns company resolution, including rejection of consumer email domains. */
export const companyLookupLive = (
  key: Redacted.Redacted<string>,
  endpoint = "https://api.context.dev/v1/brand/retrieve",
) =>
  Layer.effect(
    CompanyLookup,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return CompanyLookup.of({
        lookup: (domain) =>
          Effect.gen(function* () {
            const request = yield* HttpClientRequest.post(endpoint).pipe(
              HttpClientRequest.bearerToken(key),
              HttpClientRequest.bodyJson({
                // Send only the domain identity, never the user's actual email address.
                // The email resolver rejects free/disposable domains before returning a brand.
                type: "by_email",
                email: `workspace@${domain}`,
                timeoutOpts: { milliseconds: 12000, behavior: "fail" },
              }),
            );
            const response = yield* client.execute(request);
            if (response.status === 404 || response.status === 422) return null;
            if (response.status < 200 || response.status >= 300)
              return yield* new CompanyLookupFailed();
            const { brand, partial } = yield* response.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(BrandResponse)),
            );
            // Do not permanently cache a timeout as an unmatched or incomplete company.
            if (partial === true) return yield* new CompanyLookupFailed();
            if (!brand?.title?.trim()) return null;
            const logos =
              brand.logos?.filter((logo) => Schema.is(OrganizationLogo)(logo.url)) ?? [];
            const logo = logos.find((item) => item.type === "icon") ?? logos[0];
            return yield* Schema.decodeUnknownEffect(CompanyProfile)({
              name: brand.title.trim().slice(0, 120),
              website: `https://${brand.domain}`,
              description: brand.description?.slice(0, 2000) ?? null,
              logo: logo?.url ?? null,
              colors:
                brand.colors
                  ?.map((color) => color.hex)
                  .filter((color) => /^#[0-9a-f]{3,8}$/i.test(color)) ?? [],
            });
          }).pipe(
            Effect.timeout("15 seconds"),
            Effect.mapError(() => new CompanyLookupFailed()),
            Effect.withSpan("onboarding.companyLookup"),
          ),
      });
    }),
  );
