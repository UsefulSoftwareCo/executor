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
  type ParsedDocument,
} from "@executor-js/plugin-openapi";

import {
  MICROSOFT_AUTHORIZATION_URL,
  MICROSOFT_AUTH_TEMPLATE_SLUG,
  MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG,
  MICROSOFT_GRAPH_BASE_URL,
  MICROSOFT_GRAPH_BASE_SCOPES,
  MICROSOFT_GRAPH_CLIENT_CREDENTIALS_SCOPES,
  MICROSOFT_GRAPH_DELEGATED_DEFAULT_SCOPES,
  MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  MICROSOFT_GRAPH_OPENAPI_URL,
  MICROSOFT_GRAPH_PERMISSIONS_REFERENCE_URL,
  MICROSOFT_TOKEN_URL,
  microsoftGraphExactPathsForPresetIds,
  microsoftGraphPathPrefixesForPresetIds,
  microsoftGraphPresetIdsCoverFullGraph,
  microsoftGraphScopesForPresetIds,
  microsoftGraphTagPrefixesForPresetIds,
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
  readonly parsedDocument?: ParsedDocument;
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
  readonly tagPrefixes: readonly string[];
  readonly coversFullGraph: boolean;
  readonly authenticationTemplate: readonly Authentication[];
}

export type MicrosoftGraphIntegrationConfig = OpenApiIntegrationConfig & {
  readonly microsoftGraphPresetIds?: readonly string[];
  readonly microsoftGraphCustomScopes?: readonly string[];
  readonly microsoftGraphScopes?: readonly string[];
  readonly microsoftGraphExactPaths?: readonly string[];
  readonly microsoftGraphPathPrefixes?: readonly string[];
  readonly microsoftGraphTagPrefixes?: readonly string[];
  readonly microsoftGraphCoversFullGraph?: boolean;
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
  microsoftGraphTagPrefixes: Schema.optional(Schema.Array(Schema.String)),
  microsoftGraphCoversFullGraph: Schema.optional(Schema.Boolean),
  microsoftGraphAuthorizationUrl: Schema.optional(Schema.String),
  microsoftGraphTokenUrl: Schema.optional(Schema.String),
  microsoftGraphClientCredentialsTokenUrl: Schema.optional(Schema.String),
});

const decodeMicrosoftConfig = Schema.decodeUnknownOption(MicrosoftGraphIntegrationConfigSchema);

type MicrosoftGraphOpenApiDocument = ParsedDocument & Record<string, unknown>;

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
  const tagPrefixes = microsoftGraphTagPrefixesForPresetIds(presetIds);
  const coversFullGraph = microsoftGraphPresetIdsCoverFullGraph(presetIds);
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
    tagPrefixes,
    coversFullGraph,
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

const HTTP_METHODS = new Set(["delete", "get", "patch", "post", "put"]);
const BASE_OAUTH_SCOPES = new Set(["offline_access", "openid", "profile", "email"]);

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
    pathPrefixes.some(
      (prefix) =>
        variant === prefix || variant.startsWith(`${prefix}/`) || variant.startsWith(`${prefix}(`),
    ),
  );
};

const operationTags = (operation: Record<string, unknown>): readonly string[] =>
  Array.isArray(operation.tags)
    ? operation.tags.filter((tag): tag is string => typeof tag === "string")
    : [];

const operationMatchesTagPrefix = (
  operation: Record<string, unknown>,
  tagPrefixes: readonly string[],
): boolean =>
  tagPrefixes.length > 0 &&
  operationTags(operation).some((tag) =>
    tagPrefixes.some((prefix) => tag === prefix || tag.startsWith(prefix)),
  );

const isGraphPermissionScope = (value: string): boolean =>
  value.startsWith("https://graph.microsoft.com/") ||
  /^[A-Z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+(?:\.All)?$/.test(value);

export const parseMicrosoftGraphDelegatedScopes = (
  permissionsReference: string,
): readonly string[] =>
  uniqueStrings(
    permissionsReference.split(/\n(?=###\s+)/).flatMap((section) => {
      const scope = section.match(/^###\s+([^\n]+)$/m)?.[1]?.trim();
      if (!scope || !isGraphPermissionScope(scope)) return [];
      const identifierRow = section.match(/^\|\s*Identifier\s*\|\s*([^|]*)\|\s*([^|]*)\|/m);
      const delegatedIdentifier = identifierRow?.[2]?.trim();
      return delegatedIdentifier && delegatedIdentifier !== "-" ? [scope] : [];
    }),
  );

const collectScopeStrings = (value: unknown): readonly string[] => {
  if (typeof value === "string") return isGraphPermissionScope(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(collectScopeStrings);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(collectScopeStrings);
};

const securityScopes = (
  value: unknown,
  options?: { readonly delegatedOnly?: boolean },
): readonly string[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    return Object.entries(entry).flatMap(([scheme, scopes]) => {
      const lowerScheme = scheme.toLowerCase();
      if (options?.delegatedOnly && lowerScheme.includes("app")) return [];
      if (options?.delegatedOnly && lowerScheme.includes("application")) return [];
      return Array.isArray(scopes)
        ? scopes.filter((scope): scope is string => typeof scope === "string")
        : [];
    });
  });
};

const permissionScopes = (
  operation: Record<string, unknown>,
  options?: { readonly delegatedOnly?: boolean },
): readonly string[] => {
  const xMsPermissions = isRecord(operation["x-ms-permissions"])
    ? operation["x-ms-permissions"]
    : {};
  const delegatedScopes = options?.delegatedOnly
    ? collectScopeStrings({
        delegated: xMsPermissions.delegated,
        leastPrivilegedDelegated: xMsPermissions.leastPrivilegedDelegated,
      })
    : collectScopeStrings(xMsPermissions);
  return uniqueStrings([...securityScopes(operation.security, options), ...delegatedScopes]);
};

const operationMatchesScope = (
  operation: Record<string, unknown>,
  selectedScopes: ReadonlySet<string>,
): boolean =>
  permissionScopes(operation).some(
    (scope) => selectedScopes.has(scope) && !BASE_OAUTH_SCOPES.has(scope),
  );

const selectedOAuthScopesForPaths = (
  paths: Record<string, unknown>,
  requestedScopes: readonly string[],
  fullGraphScopes: readonly string[] = [],
): readonly string[] =>
  uniqueStrings([
    ...MICROSOFT_GRAPH_BASE_SCOPES,
    ...fullGraphScopes,
    ...requestedScopes.filter((scope) => !BASE_OAUTH_SCOPES.has(scope)),
    ...Object.values(paths).flatMap((pathItem) => {
      if (!isRecord(pathItem)) return [];
      return Object.entries(pathItem).flatMap(([method, operation]) =>
        HTTP_METHODS.has(method.toLowerCase()) && isRecord(operation)
          ? permissionScopes(operation, { delegatedOnly: true })
          : [],
      );
    }),
  ]);

const filterPathItem = (
  path: string,
  pathItem: Record<string, unknown>,
  options: {
    readonly exactPaths: ReadonlySet<string>;
    readonly pathPrefixes: readonly string[];
    readonly tagPrefixes: readonly string[];
    readonly selectedScopes: ReadonlySet<string>;
  },
): Record<string, unknown> | null => {
  const pathMatches = matchesGraphPath(path, options.exactPaths, options.pathPrefixes);
  const kept: Record<string, unknown> = {};
  let hasOperation = false;

  for (const [key, value] of Object.entries(pathItem)) {
    const lowerKey = key.toLowerCase();
    if (!HTTP_METHODS.has(lowerKey)) continue;
    if (!isRecord(value)) continue;
    if (
      pathMatches ||
      operationMatchesTagPrefix(value, options.tagPrefixes) ||
      operationMatchesScope(value, options.selectedScopes)
    ) {
      kept[key] = value;
      hasOperation = true;
    }
  }

  if (!hasOperation) return null;
  for (const [key, value] of Object.entries(pathItem)) {
    if (!HTTP_METHODS.has(key.toLowerCase())) kept[key] = value;
  }
  return kept;
};

const selectMicrosoftGraphPaths = (
  paths: Record<string, unknown>,
  options: {
    readonly scopes: readonly string[];
    readonly exactPaths: readonly string[];
    readonly pathPrefixes: readonly string[];
    readonly tagPrefixes: readonly string[];
  },
): Record<string, unknown> => {
  const exactPaths = new Set(options.exactPaths);
  const selectedScopes = new Set(options.scopes);
  const entries = Object.entries(paths).flatMap(([path, pathItem]) => {
    if (!isRecord(pathItem)) return [];
    const filtered = filterPathItem(path, pathItem, {
      exactPaths,
      pathPrefixes: options.pathPrefixes,
      tagPrefixes: options.tagPrefixes,
      selectedScopes,
    });
    return filtered ? ([[path, filtered]] as const) : [];
  });
  return Object.fromEntries(entries);
};

const decodeJsonPointerSegment = (segment: string): string =>
  decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~");

const componentRefFromString = (
  value: string,
): { readonly section: string; readonly name: string } | null => {
  if (!value.startsWith("#/components/")) return null;
  const [, section, ...nameSegments] = value.slice(2).split("/");
  if (!section || nameSegments.length === 0) return null;
  return {
    section: decodeJsonPointerSegment(section),
    name: nameSegments.map(decodeJsonPointerSegment).join("/"),
  };
};

const collectComponentRefs = (
  value: unknown,
): readonly { readonly section: string; readonly name: string }[] => {
  if (typeof value === "string") {
    const ref = componentRefFromString(value);
    return ref ? [ref] : [];
  }
  if (Array.isArray(value)) return value.flatMap(collectComponentRefs);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(collectComponentRefs);
};

const prunedComponentsForPaths = (
  components: Record<string, unknown>,
  paths: Record<string, unknown>,
): Record<string, unknown> => {
  const pruned: Record<string, Record<string, unknown>> = {};
  const queue = [...collectComponentRefs(paths)];
  const seen = new Set<string>();

  for (let index = 0; index < queue.length; index += 1) {
    const ref = queue[index];
    const key = `${ref.section}/${ref.name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const section = components[ref.section];
    if (!isRecord(section)) continue;
    const component = section[ref.name];
    if (component === undefined) continue;

    pruned[ref.section] ??= {};
    pruned[ref.section][ref.name] = component;
    queue.push(...collectComponentRefs(component));
  }

  return pruned;
};

interface MicrosoftGraphFilterResult {
  readonly specText: string;
  readonly scopes: readonly string[];
}

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

export const fetchMicrosoftGraphPermissionsReference = Effect.fn(
  "Microsoft.fetchGraphPermissionsReference",
)(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.get(MICROSOFT_GRAPH_PERMISSIONS_REFERENCE_URL).pipe(
        HttpClientRequest.setHeader("Accept", "text/markdown, text/plain, */*"),
      ),
    )
    .pipe(
      Effect.mapError(
        () =>
          new OpenApiParseError({
            message: "Failed to fetch Microsoft Graph permissions reference",
          }),
      ),
    );
  if (response.status < 200 || response.status >= 300) {
    return yield* new OpenApiParseError({
      message: `Failed to fetch Microsoft Graph permissions reference: HTTP ${response.status}`,
    });
  }
  return yield* response.text.pipe(
    Effect.mapError(
      () =>
        new OpenApiParseError({
          message: "Failed to read Microsoft Graph permissions reference body",
        }),
    ),
  );
});

const parseMicrosoftGraphOpenApiDocument = (
  specText: string,
): Effect.Effect<MicrosoftGraphOpenApiDocument, OpenApiParseError> =>
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
    if (typeof parsed.openapi !== "string" || !parsed.openapi.startsWith("3.")) {
      return yield* new OpenApiParseError({
        message: "Microsoft Graph OpenAPI document must be OpenAPI 3.x",
      });
    }
    return parsed as MicrosoftGraphOpenApiDocument;
  });

export const buildFilteredMicrosoftGraphOpenApiSpecFromDocument = (
  parsed: MicrosoftGraphOpenApiDocument,
  options: {
    readonly scopes: readonly string[];
    readonly exactPaths: readonly string[];
    readonly pathPrefixes: readonly string[];
    readonly tagPrefixes: readonly string[];
    readonly baseUrl?: string;
    readonly authorizationUrl?: string;
    readonly tokenUrl?: string;
    readonly clientCredentialsTokenUrl?: string;
    readonly fullGraphScopes?: readonly string[];
  },
): Effect.Effect<MicrosoftGraphFilterResult, OpenApiParseError> =>
  Effect.gen(function* () {
    const paths = parsed.paths;
    if (!isRecord(paths)) {
      return yield* new OpenApiParseError({
        message: "Microsoft Graph OpenAPI document is missing paths",
      });
    }

    const filteredPaths = selectMicrosoftGraphPaths(paths, options);
    if (Object.keys(filteredPaths).length === 0) {
      return yield* new OpenApiParseError({
        message: "Microsoft Graph scope selection did not match any OpenAPI paths",
      });
    }

    const scopes = selectedOAuthScopesForPaths(
      filteredPaths,
      options.scopes,
      options.fullGraphScopes ?? [],
    );
    const serverUrl = options.baseUrl ?? firstServerUrl(parsed) ?? MICROSOFT_GRAPH_BASE_URL;
    const endpoints = resolveOAuthEndpoints(parsed, options);
    const components = isRecord(parsed.components) ? parsed.components : {};
    const securitySchemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
    const filteredComponents = prunedComponentsForPaths(components, filteredPaths);
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
        ...filteredComponents,
        securitySchemes: {
          ...securitySchemes,
          [MICROSOFT_AUTH_TEMPLATE_SLUG]: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: endpoints.authorizationUrl,
                tokenUrl: endpoints.tokenUrl,
                scopes: Object.fromEntries(scopes.map((scope) => [scope, scope])),
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
      security: [{ [MICROSOFT_AUTH_TEMPLATE_SLUG]: [...scopes] }],
    };

    const filteredSpecText = yield* Effect.try({
      try: () => YAML.stringify(next),
      catch: () =>
        new OpenApiParseError({
          message: "Failed to serialize Microsoft Graph OpenAPI document",
        }),
    });
    return { specText: filteredSpecText, scopes };
  });

export const buildFilteredMicrosoftGraphOpenApiSpec = (
  specText: string,
  options: Parameters<typeof buildFilteredMicrosoftGraphOpenApiSpecFromDocument>[1],
): Effect.Effect<MicrosoftGraphFilterResult, OpenApiParseError> =>
  Effect.gen(function* () {
    const parsed = yield* parseMicrosoftGraphOpenApiDocument(specText);
    return yield* buildFilteredMicrosoftGraphOpenApiSpecFromDocument(parsed, options);
  });

export const filterMicrosoftGraphOpenApiSpec = (
  specText: string,
  options: Parameters<typeof buildFilteredMicrosoftGraphOpenApiSpec>[1],
): Effect.Effect<string, OpenApiParseError> =>
  buildFilteredMicrosoftGraphOpenApiSpec(specText, options).pipe(
    Effect.map((result) => result.specText),
  );

export const buildMicrosoftGraphOpenApiSpec = (
  input: MicrosoftGraphSelectionInput,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient, never, never>,
): Effect.Effect<MicrosoftGraphSpecBuild, OpenApiParseError> =>
  Effect.gen(function* () {
    const selection = normalizeSelection(input);
    const sourceText = yield* fetchMicrosoftGraphOpenApiSpec(selection.specUrl).pipe(
      Effect.provide(httpClientLayer),
    );
    const permissionsReference =
      selection.coversFullGraph === true
        ? yield* fetchMicrosoftGraphPermissionsReference().pipe(Effect.provide(httpClientLayer))
        : undefined;
    const fullGraphScopes = permissionsReference
      ? parseMicrosoftGraphDelegatedScopes(permissionsReference)
      : [];
    const parsed = yield* parseMicrosoftGraphOpenApiDocument(sourceText);
    const endpoints = resolveOAuthEndpoints(parsed, selection);
    const graphPaths = parsed.paths;
    if (!isRecord(graphPaths)) {
      return yield* new OpenApiParseError({
        message: "Microsoft Graph OpenAPI document is missing paths",
      });
    }
    if (selection.coversFullGraph === true) {
      const scopes =
        selection.customScopes.length === 0
          ? MICROSOFT_GRAPH_DELEGATED_DEFAULT_SCOPES
          : selectedOAuthScopesForPaths(
              graphPaths,
              uniqueStrings([...MICROSOFT_GRAPH_BASE_SCOPES, ...selection.customScopes]),
              fullGraphScopes,
            );
      return {
        ...selection,
        specText: sourceText,
        parsedDocument: parsed,
        scopes,
        authorizationUrl: endpoints.authorizationUrl,
        tokenUrl: endpoints.tokenUrl,
        clientCredentialsTokenUrl: endpoints.clientCredentialsTokenUrl,
        authenticationTemplate: microsoftOAuthTemplate(scopes, endpoints),
      };
    }
    const filtered = yield* buildFilteredMicrosoftGraphOpenApiSpecFromDocument(parsed, {
      ...selection,
      scopes: selection.scopes,
      fullGraphScopes,
    });
    return {
      ...selection,
      specText: filtered.specText,
      scopes: filtered.scopes,
      authorizationUrl: endpoints.authorizationUrl,
      tokenUrl: endpoints.tokenUrl,
      clientCredentialsTokenUrl: endpoints.clientCredentialsTokenUrl,
      authenticationTemplate: microsoftOAuthTemplate(filtered.scopes, endpoints),
    };
  });
