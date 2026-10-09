/** Pure constructors over the native provider contracts. */
import { Effect, Schema } from "effect";
import { fromPromise, type PromiseMethod } from "./authoring.ts";
import {
  type AccountCheck,
  type AuthMethods,
  type FieldExposure,
  OAuth2Config,
  OAuth2Method,
  Provider,
  SecretsMethod,
} from "../contracts/provider.ts";
import type { ValidationError } from "../contracts/schema.ts";
import { parse } from "./schema.ts";

/** Declare a secrets method with an Effect decoder. */
export const secrets = <Fields extends Schema.Decoder<unknown>>(options: {
  readonly label: string;
  readonly fields: Fields;
  readonly exposure?: Readonly<Record<string, FieldExposure>>;
}): SecretsMethod<Fields> => new SecretsMethod(options);

/** Validate OAuth endpoints while declaring their app-visible response projection. */
export const oauth2 = <Response extends Schema.Decoder<unknown>>(
  config: OAuth2Config,
  response: Response,
  exposure?: Readonly<Record<string, FieldExposure>>,
): Effect.Effect<OAuth2Method<Response>, ValidationError> =>
  parse(OAuth2Config, config).pipe(
    Effect.map(
      (config) =>
        new OAuth2Method({ config, response, ...(exposure === undefined ? {} : { exposure }) }),
    ),
  );

/** Author options: the account check is an ordinary async function. */
export interface ProviderOptions<Auth extends AuthMethods> {
  readonly name: string;
  readonly auth: Auth;
  /**
   * Hosts the credentials may be sent to: `api.example.com`, `api.example.com:8443`, or
   * `*.example.com` for one level of subdomain. Secret fields then reach app code as handles
   * that the outbound network replaces only on requests to these hosts. An account records the
   * hosts it was connected for; changing them does not change the provider, but an existing
   * account sends only to hosts it was connected for until it is connected again.
   */
  readonly hosts?: readonly string[];
  /** Verify a connected account with a safe read, optionally reporting its upstream identity. */
  readonly health?: PromiseMethod<AccountCheck<Auth>["run"]>;
}

/** Retain the provider and literal method names without registering or authenticating it. */
export const defineProvider = <const Auth extends AuthMethods>({
  health,
  ...options
}: ProviderOptions<Auth>): Provider<Auth> => {
  if (health === undefined) return new Provider(options);
  // SAFETY: the host runs a check only with an account bound against this provider: its method is
  // a key of `auth` and its fields were decoded by that method's schema, as `Auth` promises.
  const run = fromPromise(health, "check") as unknown as AccountCheck<AuthMethods>["run"];
  return new Provider({ ...options, health: { run } });
};
