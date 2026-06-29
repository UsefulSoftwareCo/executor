import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { ApiKeyAuthMethod, ApiKeyAuthTemplate } from "@executor-js/sdk/http-auth";
import {
  InternalError,
  IntegrationAlreadyExistsError,
  IntegrationNotFoundError,
  IntegrationSlug,
} from "@executor-js/sdk/shared";
import {
  OpenApiExtractionError,
  OpenApiOAuthError,
  OpenApiParseError,
} from "@executor-js/plugin-openapi";

const DomainErrors = [
  InternalError,
  OpenApiParseError,
  OpenApiExtractionError,
  OpenApiOAuthError,
  IntegrationAlreadyExistsError,
] as const;

const IntegrationNotFound = IntegrationNotFoundError.annotate({ httpApiStatus: 404 });

const UpdateErrors = [
  InternalError,
  OpenApiParseError,
  OpenApiExtractionError,
  OpenApiOAuthError,
  IntegrationNotFound,
] as const;

const SlugParams = {
  slug: Schema.String,
};

const OAuthTemplatePayload = Schema.Struct({
  slug: Schema.String,
  kind: Schema.Literal("oauth2"),
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  scopes: Schema.Array(Schema.String),
});

const AuthenticationPayload = Schema.Union([OAuthTemplatePayload, ApiKeyAuthTemplate]);
const AuthenticationResponse = Schema.Union([OAuthTemplatePayload, ApiKeyAuthMethod]);

const AddBundlePayload = Schema.Struct({
  urls: Schema.Array(Schema.String),
  slug: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
});

const AddBundleResponse = Schema.Struct({
  slug: IntegrationSlug,
  toolCount: Schema.Number,
});

const UpdateBundlePayload = Schema.Struct({
  urls: Schema.optional(Schema.Array(Schema.String)),
});

const UpdateBundleResponse = Schema.Struct({
  slug: IntegrationSlug,
  toolCount: Schema.Number,
  addedTools: Schema.Array(Schema.String),
  removedTools: Schema.Array(Schema.String),
});

const IntegrationView = Schema.Struct({
  slug: IntegrationSlug,
  description: Schema.String,
  kind: Schema.String,
  canRemove: Schema.Boolean,
  canRefresh: Schema.Boolean,
});

const GoogleConfigView = Schema.Struct({
  googleDiscoveryUrls: Schema.optional(Schema.Array(Schema.String)),
  baseUrl: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  authenticationTemplate: Schema.optional(Schema.Array(AuthenticationResponse)),
});

const ConfigurePayload = Schema.Struct({
  authenticationTemplate: Schema.Array(AuthenticationPayload),
  mode: Schema.optional(Schema.Literals(["merge", "replace"])),
});

const ConfigureResponse = Schema.Struct({
  authenticationTemplate: Schema.Array(AuthenticationResponse),
});

export const GoogleGroup = HttpApiGroup.make("google")
  .add(
    HttpApiEndpoint.post("addBundle", "/google/bundles", {
      payload: AddBundlePayload,
      success: AddBundleResponse,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getIntegration", "/google/integrations/:slug", {
      params: SlugParams,
      success: Schema.NullOr(IntegrationView),
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getConfig", "/google/integrations/:slug/config", {
      params: SlugParams,
      success: Schema.NullOr(GoogleConfigView),
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("configure", "/google/integrations/:slug/config", {
      params: SlugParams,
      payload: ConfigurePayload,
      success: ConfigureResponse,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("updateBundle", "/google/integrations/:slug/bundle", {
      params: SlugParams,
      payload: UpdateBundlePayload,
      success: UpdateBundleResponse,
      error: UpdateErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeBundle", "/google/integrations/:slug", {
      params: SlugParams,
      success: Schema.Void,
      error: DomainErrors,
    }),
  );
