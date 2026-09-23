/** Pure constructors over the native provider contracts. */
import { Effect, Schema } from "effect";
import {
  type AuthMethods,
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
}): SecretsMethod<Fields> => new SecretsMethod(options);

/** Validate OAuth endpoints while declaring their app-visible response projection. */
export const oauth2 = <Response extends Schema.Decoder<unknown>>(
  config: OAuth2Config,
  response: Response,
): Effect.Effect<OAuth2Method<Response>, ValidationError> =>
  parse(OAuth2Config, config).pipe(Effect.map((config) => new OAuth2Method({ config, response })));

/** Retain the provider and literal method names without registering or authenticating it. */
export const defineProvider = <const Auth extends AuthMethods>(options: {
  readonly name: string;
  readonly auth: Auth;
}): Provider<Auth> => new Provider(options);
