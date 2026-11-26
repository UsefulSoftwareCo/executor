import { Schema } from "effect";

export const OperatorOAuthFixture = Schema.Struct({
  port: Schema.Number,
  clientId: Schema.String,
  clientSecret: Schema.String,
  reportingPort: Schema.Number,
});
export const syntheticCloudGoogle = {
  clientId: "synthetic-cloud-google-client.apps.googleusercontent.com",
  clientSecret: "synthetic-cloud-google-secret",
} as const;
export const operatorOAuthFile = "operator-oauth.json";
export const syntheticReportingClient = {
  id: "synthetic-cloud-reporting",
  clientId: "synthetic-reporting-client",
  clientSecret: "synthetic-reporting-secret",
} as const;
