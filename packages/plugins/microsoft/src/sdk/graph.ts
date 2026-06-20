import { Effect, Option, Schema } from "effect";
import type { Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as YAML from "yaml";

import { AuthTemplateSlug } from "@executor-js/sdk/core";
import {
  AuthenticationSchema,
  OpenApiParseError,
  type Authentication,
  type OpenApiIntegrationConfig,
} from "@executor-js/plugin-openapi";

import {
  MICROSOFT_AUTHORIZATION_URL,
  MICROSOFT_AUTH_TEMPLATE_SLUG,
  MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG,
  MICROSOFT_GRAPH_BASE_URL,
  MICROSOFT_GRAPH_CLIENT_CREDENTIALS_SCOPES,
  MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  MICROSOFT_GRAPH_OPENAPI_URL,
  MICROSOFT_TOKEN_URL,
  microsoftGraphExactPathsForPresetIds,
  microsoftGraphPathPrefixesForPresetIds,
  microsoftGraphScopesForPresetIds,
} from "./presets";

export interface MicrosoftGraphSelectionInput {
  readonly presetIds?: readonly string[];
  readonly customScopes?: readonly string[];
  readonly baseUrl?: string;
  readonly specUrl?: string;
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  readonly clientCredentialsTokenUrl?: string;
}

export interface MicrosoftGraphSpecBuild {
  readonly specText: string;
  readonly specUrl: string;
  readonly baseUrl?: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly clientCredentialsTokenUrl: string;
  readonly presetIds: readonly string[];
  readonly customScopes: readonly string[];
  readonly scopes: readonly string[];
  readonly exactPaths: readonly string[];
  readonly pathPrefixes: readonly string[];
  readonly authenticationTemplate: readonly Authentication[];
}

export type MicrosoftGraphIntegrationConfig = OpenApiIntegrationConfig & {
  readonly microsoftGraphPresetIds?: readonly string[];
  readonly microsoftGraphCustomScopes?: readonly string[];
  readonly microsoftGraphScopes?: readonly string[];
  readonly microsoftGraphExactPaths?: readonly string[];
  readonly microsoftGraphPathPrefixes?: readonly string[];
  readonly microsoftGraphAuthorizationUrl?: string;
  readonly microsoftGraphTokenUrl?: string;
  readonly microsoftGraphClientCredentialsTokenUrl?: string;
};

const MicrosoftGraphIntegrationConfigSchema = Schema.Struct({
  specHash: Schema.optional(Schema.String),
  sourceUrl: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  authenticationTemplate: Schema.optional(Schema.Array(AuthenticationSchema)),
  microsoftGraphPresetIds: Schema.optional(Schema.Array(Schema.String)),
  microsoftGraphCustomScopes: Schema.optional(Schema.Array(Schema.String)),
  microsoftGraphScopes: Schema.optional(Schema.Array(Schema.String)),
  microsoftGraphExactPaths: Schema.optional(Schema.Array(Schema.String)),
  microsoftGraphPathPrefixes: Schema.optional(Schema.Array(Schema.String)),
  microsoftGraphAuthorizationUrl: Schema.optional(Schema.String),
  microsoftGraphTokenUrl: Schema.optional(Schema.String),
  microsoftGraphClientCredentialsTokenUrl: Schema.optional(Schema.String),
});

const decodeMicrosoftConfig = Schema.decodeUnknownOption(MicrosoftGraphIntegrationConfigSchema);

export const decodeMicrosoftGraphIntegrationConfig = (
  value: unknown,
): MicrosoftGraphIntegrationConfig | null =>
  Option.getOrNull(decodeMicrosoftConfig(value)) as MicrosoftGraphIntegrationConfig | null;

const uniqueStrings = (values: Iterable<string>): readonly string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
};

const normalizeSelection = (input: MicrosoftGraphSelectionInput) => {
  const presetIds = uniqueStrings(
    input.presetIds && input.presetIds.length > 0
      ? input.presetIds
      : MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  );
  const customScopes = uniqueStrings(input.customScopes ?? []);
  const scopes = microsoftGraphScopesForPresetIds(presetIds, customScopes);
  const exactPaths = microsoftGraphExactPathsForPresetIds(presetIds);
  const pathPrefixes = microsoftGraphPathPrefixesForPresetIds(presetIds);
  const specUrl = input.specUrl?.trim() || MICROSOFT_GRAPH_OPENAPI_URL;
  const baseUrl = input.baseUrl?.trim() || undefined;
  const authorizationUrl = input.authorizationUrl?.trim() || undefined;
  const tokenUrl = input.tokenUrl?.trim() || undefined;
  const clientCredentialsTokenUrl = input.clientCredentialsTokenUrl?.trim() || undefined;
  return {
    presetIds,
    customScopes,
    scopes,
    exactPaths,
    pathPrefixes,
    specUrl,
    baseUrl,
    authorizationUrl,
    tokenUrl,
    clientCredentialsTokenUrl,
  };
};

interface MicrosoftOAuthEndpoints {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly clientCredentialsTokenUrl: string;
}

const microsoftOAuthTemplate = (
  scopes: readonly string[],
  endpoints: MicrosoftOAuthEndpoints,
): readonly Authentication[] => [
  {
    slug: AuthTemplateSlug.make(MICROSOFT_AUTH_TEMPLATE_SLUG),
    kind: "oauth2",
    authorizationUrl: endpoints.authorizationUrl,
    tokenUrl: endpoints.tokenUrl,
    scopes,
  },
  {
    slug: AuthTemplateSlug.make(MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG),
    kind: "oauth2",
    authorizationUrl: endpoints.authorizationUrl,
    tokenUrl: endpoints.clientCredentialsTokenUrl,
    scopes: [...MICROSOFT_GRAPH_CLIENT_CREDENTIALS_SCOPES],
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const firstString = (values: readonly unknown[]): string | undefined =>
  values.find((value): value is string => typeof value === "string" && value.trim().length > 0);

const recordValues = (value: unknown): readonly unknown[] =>
  isRecord(value) ? Object.values(value) : [];

const firstServerUrl = (parsed: Record<string, unknown>): string | undefined => {
  const servers = parsed.servers;
  if (!Array.isArray(servers)) return undefined;
  for (const server of servers) {
    if (!isRecord(server)) continue;
    const url = server.url;
    if (typeof url === "string" && url.trim().length > 0) return url.trim();
  }
  return undefined;
};

const firstOAuthFlows = (parsed: Record<string, unknown>): readonly Record<string, unknown>[] => {
  const components = isRecord(parsed.components) ? parsed.components : {};
  const securitySchemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
  return recordValues(securitySchemes)
    .filter(isRecord)
    .filter((scheme) => scheme.type === "oauth2")
    .flatMap((scheme) => recordValues(scheme.flows).filter(isRecord));
};

const resolveOAuthEndpoints = (
  parsed: Record<string, unknown>,
  overrides: {
    readonly authorizationUrl?: string;
    readonly tokenUrl?: string;
    readonly clientCredentialsTokenUrl?: string;
  },
): MicrosoftOAuthEndpoints => {
  const flows = firstOAuthFlows(parsed);
  const authorizationCode = flows.find((flow) => flow.authorizationUrl !== undefined);
  const clientCredentials = flows.find(
    (flow) => flow.tokenUrl !== undefined && flow.authorizationUrl === undefined,
  );
  const authorizationUrl =
    overrides.authorizationUrl ??
    (isRecord(authorizationCode) ? firstString([authorizationCode.authorizationUrl]) : undefined) ??
    MICROSOFT_AUTHORIZATION_URL;
  const tokenUrl =
    overrides.tokenUrl ??
    (isRecord(authorizationCode) ? firstString([authorizationCode.tokenUrl]) : undefined) ??
    firstString(flows.map((flow) => flow.tokenUrl)) ??
    MICROSOFT_TOKEN_URL;
  const clientCredentialsTokenUrl =
    overrides.clientCredentialsTokenUrl ??
    (isRecord(clientCredentials) ? firstString([clientCredentials.tokenUrl]) : undefined) ??
    tokenUrl;
  return { authorizationUrl, tokenUrl, clientCredentialsTokenUrl };
};

const graphPathMatchVariants = (path: string): readonly string[] => {
  const withoutVersion = path.replace(/^\/(?:v1\.0|beta)(?=\/)/, "");
  return withoutVersion === path ? [path, `/v1.0${path}`] : [path, withoutVersion];
};

const matchesGraphPath = (
  path: string,
  exactPaths: ReadonlySet<string>,
  pathPrefixes: readonly string[],
): boolean => {
  const variants = graphPathMatchVariants(path);
  if (variants.some((variant) => exactPaths.has(variant))) return true;
  return variants.some((variant) =>
    pathPrefixes.some((prefix) => variant === prefix || variant.startsWith(`${prefix}/`)),
  );
};

export const fetchMicrosoftGraphOpenApiSpec = Effect.fn("Microsoft.fetchGraphOpenApiSpec")(
  function* (specUrl: string) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.get(specUrl).pipe(
          HttpClientRequest.setHeader("Accept", "application/yaml, text/yaml, */*"),
        ),
      )
      .pipe(
        Effect.mapError(
          () =>
            new OpenApiParseError({
              message: "Failed to fetch Microsoft Graph OpenAPI document",
            }),
        ),
      );
    if (response.status < 200 || response.status >= 300) {
      return yield* new OpenApiParseError({
        message: `Failed to fetch Microsoft Graph OpenAPI document: HTTP ${response.status}`,
      });
    }
    return yield* response.text.pipe(
      Effect.mapError(
        () =>
          new OpenApiParseError({
            message: "Failed to read Microsoft Graph OpenAPI document body",
          }),
      ),
    );
  },
);

const parseMicrosoftGraphOpenApiDocument = (
  specText: string,
): Effect.Effect<Record<string, unknown>, OpenApiParseError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => YAML.parse(specText) as unknown,
      catch: () =>
        new OpenApiParseError({
          message: "Failed to parse Microsoft Graph OpenAPI document",
        }),
    });
    if (!isRecord(parsed)) {
      return yield* new OpenApiParseError({
        message: "Microsoft Graph OpenAPI document must be an object",
      });
    }
    return parsed;
  });

export const filterMicrosoftGraphOpenApiSpec = (
  specText: string,
  options: {
    readonly scopes: readonly string[];
    readonly exactPaths: readonly string[];
    readonly pathPrefixes: readonly string[];
    readonly baseUrl?: string;
    readonly authorizationUrl?: string;
    readonly tokenUrl?: string;
    readonly clientCredentialsTokenUrl?: string;
  },
): Effect.Effect<string, OpenApiParseError> =>
  Effect.gen(function* () {
    const parsed = yield* parseMicrosoftGraphOpenApiDocument(specText);
    const paths = parsed.paths;
    if (!isRecord(paths)) {
      return yield* new OpenApiParseError({
        message: "Microsoft Graph OpenAPI document is missing paths",
      });
    }

    const exactPaths = new Set(options.exactPaths);
    const filteredPaths = Object.fromEntries(
      Object.entries(paths).filter(([path]) =>
        matchesGraphPath(path, exactPaths, options.pathPrefixes),
      ),
    );
    if (Object.keys(filteredPaths).length === 0) {
      return yield* new OpenApiParseError({
        message: "Microsoft Graph scope selection did not match any OpenAPI paths",
      });
    }

    const serverUrl = options.baseUrl ?? firstServerUrl(parsed) ?? MICROSOFT_GRAPH_BASE_URL;
    const endpoints = resolveOAuthEndpoints(parsed, options);
    const components = isRecord(parsed.components) ? parsed.components : {};
    const securitySchemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
    const next = {
      ...parsed,
      info: {
        ...(isRecord(parsed.info) ? parsed.info : {}),
        title: "Microsoft Graph",
        description: "Selected Microsoft Graph workloads from the v1.0 OpenAPI document.",
      },
      servers: [{ url: serverUrl }],
      paths: filteredPaths,
      components: {
        ...components,
        securitySchemes: {
          ...securitySchemes,
          [MICROSOFT_AUTH_TEMPLATE_SLUG]: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: endpoints.authorizationUrl,
                tokenUrl: endpoints.tokenUrl,
                scopes: Object.fromEntries(options.scopes.map((scope) => [scope, scope])),
              },
              clientCredentials: {
                tokenUrl: endpoints.clientCredentialsTokenUrl,
                scopes: Object.fromEntries(
                  MICROSOFT_GRAPH_CLIENT_CREDENTIALS_SCOPES.map((scope) => [scope, scope]),
                ),
              },
            },
          },
        },
      },
      security: [{ [MICROSOFT_AUTH_TEMPLATE_SLUG]: [...options.scopes] }],
    };

    return yield* Effect.try({
      try: () => YAML.stringify(next),
      catch: () =>
        new OpenApiParseError({
          message: "Failed to serialize Microsoft Graph OpenAPI document",
        }),
    });
  });

export const buildMicrosoftGraphOpenApiSpec = (
  input: MicrosoftGraphSelectionInput,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient, never, never>,
): Effect.Effect<MicrosoftGraphSpecBuild, OpenApiParseError> =>
  Effect.gen(function* () {
    const selection = normalizeSelection(input);
    const sourceText = yield* fetchMicrosoftGraphOpenApiSpec(selection.specUrl).pipe(
      Effect.provide(httpClientLayer),
    );
    const parsed = yield* parseMicrosoftGraphOpenApiDocument(sourceText);
    const endpoints = resolveOAuthEndpoints(parsed, selection);
    const specText = yield* filterMicrosoftGraphOpenApiSpec(sourceText, selection);
    return {
      ...selection,
      specText,
      authorizationUrl: endpoints.authorizationUrl,
      tokenUrl: endpoints.tokenUrl,
      clientCredentialsTokenUrl: endpoints.clientCredentialsTokenUrl,
      authenticationTemplate: microsoftOAuthTemplate(selection.scopes, endpoints),
    };
  });
