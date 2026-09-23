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

/** External test services provisioned independently of Executor; never browser configuration. */
export const EmulatedServices = Schema.Struct({
  google: Provider,
  github: Provider,
  mail: Schema.Struct({ baseUrl: BaseUrl, token: Schema.NonEmptyString }),
  company: Schema.Struct({ baseUrl: BaseUrl, token: Schema.NonEmptyString }),
  billing: Schema.Struct({ baseUrl: BaseUrl, token: Schema.NonEmptyString }),
});
