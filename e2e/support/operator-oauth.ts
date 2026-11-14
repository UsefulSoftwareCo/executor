import { Schema } from "effect";

/**
 * The operator's OAuth client every managed local Cloud is configured with. Its authorization
 * server is a loopback issuer on `port`, which only the scenario that proves Cloud's operator
 * settings starts; no other provider shares its endpoints, so it is offered to no one else.
 */
export const OperatorOAuthFixture = Schema.Struct({
  port: Schema.Number,
  clientId: Schema.String,
  clientSecret: Schema.String,
});
/** Where a managed Cloud run records its operator OAuth fixture, under the run directory. */
export const operatorOAuthFile = "operator-oauth.json";
