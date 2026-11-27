import { Schema } from "effect";

export const OperatorOAuthFixture = Schema.Struct({
  port: Schema.Number,
  clientId: Schema.String,
  clientSecret: Schema.String,
});
export const syntheticCloudGoogle = {
  clientId: "synthetic-cloud-google-client.apps.googleusercontent.com",
  clientSecret: "synthetic-cloud-google-secret",
} as const;
export const operatorOAuthFile = "operator-oauth.json";
