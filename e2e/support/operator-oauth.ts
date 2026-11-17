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
/**
 * Synthetic credentials for the reviewed Executor for Google client, which every managed local
 * Cloud turns on, so scenarios can check which sign-ins Cloud's own Google registration is offered
 * for. Nothing signs in with them: only providers on Google's own endpoints match the client, and
 * no scenario follows its authorization URL.
 */
export const syntheticCloudGoogle = {
  clientId: "synthetic-cloud-google-client.apps.googleusercontent.com",
  clientSecret: "synthetic-cloud-google-secret",
} as const;
/** Where a managed Cloud run records its operator OAuth fixture, under the run directory. */
export const operatorOAuthFile = "operator-oauth.json";
