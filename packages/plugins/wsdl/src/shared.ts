import { Schema } from "effect";
import { IntegrationSlug } from "@executor-js/sdk/shared";
import { ApiKeyAuthMethod, NoneAuthMethod } from "@executor-js/sdk/http-auth";
export const AddWsdlInput = Schema.Struct({
  slug: IntegrationSlug,
  name: Schema.String,
  wsdl: Schema.String,
  service: Schema.optional(Schema.String),
  port: Schema.optional(Schema.String),
  endpoint: Schema.optional(Schema.String),
  authenticationTemplate: Schema.optional(
    Schema.Array(Schema.Union([ApiKeyAuthMethod, NoneAuthMethod])),
  ),
});
