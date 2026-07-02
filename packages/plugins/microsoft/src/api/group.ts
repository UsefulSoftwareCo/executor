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

const AddGraphPayload = Schema.Struct({
  presetIds: Schema.Array(Schema.String),
  customScopes: Schema.optional(Schema.Array(Schema.String)),
  slug: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  specUrl: Schema.optional(Schema.String),
  authorizationUrl: Schema.optional(Schema.String),
  tokenUrl: Schema.optional(Schema.String),
  clientCredentialsTokenUrl: Schema.optional(Schema.String),
});

const AddGraphResponse = Schema.Struct({
  slug: IntegrationSlug,
  toolCount: Schema.Number,
});

const UpdateGraphPayload = Schema.Struct({
  presetIds: Schema.optional(Schema.Array(Schema.String)),
  customScopes: Schema.optional(Schema.Array(Schema.String)),
  baseUrl: Schema.optional(Schema.String),
  specUrl: Schema.optional(Schema.String),
  authorizationUrl: Schema.optional(Schema.String),
  tokenUrl: Schema.optional(Schema.String),
  clientCredentialsTokenUrl: Schema.optional(Schema.String),
});

const UpdateGraphResponse = Schema.Struct({
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

const MicrosoftConfigView = Schema.Struct({
  sourceUrl: Schema.optional(Schema.String),
  microsoftGraphPresetIds: Schema.optional(Schema.Array(Schema.String)),
  microsoftGraphCustomScopes: Schema.optional(Schema.Array(Schema.String)),
  microsoftGraphScopes: Schema.optional(Schema.Array(Schema.String)),
  microsoftGraphExactPaths: Schema.optional(Schema.Array(Schema.String)),
  microsoftGraphPathPrefixes: Schema.optional(Schema.Array(Schema.String)),
  microsoftGraphTagPrefixes: Schema.optional(Schema.Array(Schema.String)),
  microsoftGraphCoversFullGraph: Schema.optional(Schema.Boolean),
  microsoftGraphAuthorizationUrl: Schema.optional(Schema.String),
  microsoftGraphTokenUrl: Schema.optional(Schema.String),
  microsoftGraphClientCredentialsTokenUrl: Schema.optional(Schema.String),
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

export const MicrosoftGroup = HttpApiGroup.make("microsoft")
  .add(
    HttpApiEndpoint.post("addGraph", "/microsoft/graph", {
      payload: AddGraphPayload,
      success: AddGraphResponse,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getIntegration", "/microsoft/integrations/:slug", {
      params: SlugParams,
      success: Schema.NullOr(IntegrationView),
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getConfig", "/microsoft/integrations/:slug/config", {
      params: SlugParams,
      success: Schema.NullOr(MicrosoftConfigView),
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("configure", "/microsoft/integrations/:slug/config", {
      params: SlugParams,
      payload: ConfigurePayload,
      success: ConfigureResponse,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("updateGraph", "/microsoft/integrations/:slug/graph", {
      params: SlugParams,
      payload: UpdateGraphPayload,
      success: UpdateGraphResponse,
      error: UpdateErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeGraph", "/microsoft/integrations/:slug", {
      params: SlugParams,
      success: Schema.Void,
      error: DomainErrors,
    }),
  );
