import { Schema } from "effect";

const BaseUrl = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const url = URL.parse(value);
      return (
        url !== null &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !value.endsWith("/") &&
        url.protocol === "https:" &&
        (url.hostname === "emulators.dev" || url.hostname.endsWith(".emulators.dev"))
      );
    },
    { message: "Use an HTTPS service instance on emulators.dev" },
  ),
);
const Provider = Schema.Struct({
  baseUrl: BaseUrl,
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.NonEmptyString,
});

const GoogleDiscovery = Schema.Struct({
  issuer: BaseUrl,
  authorization_endpoint: BaseUrl,
  token_endpoint: BaseUrl,
  userinfo_endpoint: BaseUrl,
  jwks_uri: BaseUrl,
  id_token_signing_alg_values_supported: Schema.Array(Schema.Literal("RS256")).check(
    Schema.isMinLength(1),
  ),
});
const GoogleProvider = Schema.Struct({ ...Provider.fields, discovery: GoogleDiscovery }).check(
  Schema.makeFilter(
    ({ baseUrl, discovery }) =>
      discovery.issuer === baseUrl &&
      [
        discovery.authorization_endpoint,
        discovery.token_endpoint,
        discovery.userinfo_endpoint,
        discovery.jwks_uri,
      ].every((endpoint) => endpoint.startsWith(`${baseUrl}/`)),
  ),
);

/** External test services provisioned independently of Executor; never browser configuration. */
export const EmulatedServices = Schema.Struct({
  google: GoogleProvider,
  github: Provider,
  mail: Schema.Struct({ baseUrl: BaseUrl, token: Schema.NonEmptyString }),
  company: Schema.Struct({ baseUrl: BaseUrl, token: Schema.NonEmptyString }),
  billing: Schema.Struct({ baseUrl: BaseUrl, token: Schema.NonEmptyString }),
});
