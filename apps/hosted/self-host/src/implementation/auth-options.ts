/** Self-host credentials and optional operator-owned OpenID Connect configuration. */
import { authOptions, authSettings } from "@executor-js/hosted-server";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { organization } from "better-auth/plugins/organization";
import { Config, Effect, Option, Redacted, Schema } from "effect";

const Sso = Schema.Struct({
  discoveryUrl: Schema.String.check(
    Schema.makeFilter(
      (value) => {
        try {
          return new URL(value).protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "SSO discovery must use HTTPS" },
    ),
  ),
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.Redacted(Schema.NonEmptyString),
  allowedDomains: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
});

/** SSO stays disabled unless explicitly configured; partial configuration fails startup. */
export const selfHostAuthSettings = Effect.gen(function* () {
  const base = yield* authSettings;
  const discovery = yield* Config.String("SSO_DISCOVERY_URL").pipe(Config.option);
  if (Option.isNone(discovery) || discovery.value === "") return { ...base, sso: null };
  const configured = yield* Config.all({
    clientId: Config.String("SSO_CLIENT_ID"),
    clientSecret: Config.Redacted("SSO_CLIENT_SECRET"),
    domains: Config.String("SSO_ALLOWED_DOMAINS"),
  });
  const sso = yield* Schema.decodeUnknownEffect(Sso)({
    ...configured,
    discoveryUrl: discovery.value,
    allowedDomains: configured.domains
      .split(",")
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean),
  });
  return { ...base, sso };
});

/** Public registration is handled by the atomic setup/invitation endpoints. */
export const selfHostAuthOptions = (
  settings: Effect.Success<typeof selfHostAuthSettings>,
  ipAddressHeaders: string[],
) => {
  const base = authOptions(settings, ipAddressHeaders);
  return {
    ...base,
    emailAndPassword: { enabled: true, disableSignUp: true },
    plugins: [
      organization({ disableOrganizationDeletion: true, allowUserToCreateOrganization: false }),
      ...base.plugins.filter((plugin) => plugin.id !== "organization"),
      genericOAuth({
        config:
          settings.sso === null
            ? []
            : [
                {
                  providerId: "sso",
                  name: "Single sign-on",
                  discoveryUrl: settings.sso.discoveryUrl,
                  clientId: settings.sso.clientId,
                  clientSecret: Redacted.value(settings.sso.clientSecret),
                  requireIdTokenVerification: true,
                  scopes: ["openid", "email", "profile"],
                },
              ],
      }),
    ],
  };
};
