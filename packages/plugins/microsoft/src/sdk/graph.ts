import { Effect, Option, Schema } from "effect";
import type { Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { AuthTemplateSlug } from "@executor-js/sdk/core";
import {
  AuthenticationSchema,
  OpenApiParseError,
  parseEntry,
  parseHead,
  parseSmallComponents,
  structuralSplit,
  type Authentication,
  type KeepPathItem,
  type OpenApiIntegrationConfig,
  type SpecStructure,
} from "@executor-js/plugin-openapi";

import {
  MICROSOFT_AUTHORIZATION_URL,
  MICROSOFT_AUTH_TEMPLATE_SLUG,
  MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG,
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

/**
 * Build the per-path-item filter that the streaming compile applies to each
 * path-item as it parses the 37MB source. Returns `undefined` for a full-graph
 * selection (keep everything). The selection predicate is identical to the old
 * two-pass filter: the selected scopes are derived from the PRESET scopes
 * (`microsoftGraphScopesForPresetIds`), not the expanded OAuth scopes, so the
 * kept operation set matches regardless of caller.
 */
export const microsoftGraphKeepPathItem = (selection: {
  readonly coversFullGraph: boolean;
  readonly presetIds: readonly string[];
  readonly customScopes: readonly string[];
  readonly exactPaths: readonly string[];
  readonly pathPrefixes: readonly string[];
  readonly tagPrefixes: readonly string[];
}): KeepPathItem | undefined => {
  if (selection.coversFullGraph) return undefined;
  const exactPaths = new Set(selection.exactPaths);
  const selectedScopes = new Set(
    microsoftGraphScopesForPresetIds(selection.presetIds, selection.customScopes),
  );
  return (path, pathItem) =>
    filterPathItem(path, pathItem, {
      exactPaths,
      pathPrefixes: selection.pathPrefixes,
      tagPrefixes: selection.tagPrefixes,
      selectedScopes,
    });
};

/**
 * Compute the OAuth scopes for the selection by streaming the source path-items
 * once (never materializing the whole tree). Mirrors the old
 * `selectedOAuthScopesForPaths`: base scopes + full-graph scopes + requested
 * scopes + the delegated permission scopes of every kept operation. `keepPathItem`
 * (when present) restricts the walk to the filtered operation set, exactly as the
 * old code computed scopes over the already-filtered paths.
 */
const streamSelectedScopes = (
  structure: SpecStructure,
  requestedScopes: readonly string[],
  fullGraphScopes: readonly string[],
  keepPathItem?: KeepPathItem,
): readonly string[] => {
  const collected = [
    ...MICROSOFT_GRAPH_BASE_SCOPES,
    ...fullGraphScopes,
    ...requestedScopes.filter((scope) => !BASE_OAUTH_SCOPES.has(scope)),
  ];
  for (const range of structure.pathItems) {
    const entry = parseEntry(structure.text, range, 2);
    if (!entry) continue;
    const [path, rawItem] = entry;
    if (!isRecord(rawItem)) continue;
    const pathItem = keepPathItem ? keepPathItem(path, rawItem) : rawItem;
    if (!pathItem) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (HTTP_METHODS.has(method.toLowerCase()) && isRecord(operation)) {
        collected.push(...permissionScopes(operation, { delegatedOnly: true }));
      }
    }
  }
  return uniqueStrings(collected);
};

export const buildMicrosoftGraphOpenApiSpec = (
  input: MicrosoftGraphSelectionInput,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient, never, never>,
): Effect.Effect<MicrosoftGraphSpecBuild, OpenApiParseError> =>
  Effect.gen(function* () {
    const selection = normalizeSelection(input);
    const sourceText = yield* fetchMicrosoftGraphOpenApiSpec(selection.specUrl).pipe(
      Effect.provide(httpClientLayer),
    );

    // Structural split is the only entry point: parsing the whole 37MB tree
    // OOMs the 128MB Workers isolate (measured: HTTP 503). No fallback. A spec
    // outside the streamable block-YAML profile is a hard error on this path;
    // arbitrary user specs still go through the generic openapi plugin.
    const structure = structuralSplit(sourceText);
    if (!structure) {
      return yield* new OpenApiParseError({
        message:
          "Microsoft Graph OpenAPI document is not in the streamable block-YAML profile; cannot compile it in-band on Workers.",
      });
    }

    // Head + small components (servers + securitySchemes) parse cheaply and
    // carry everything `resolveOAuthEndpoints` needs.
    const headDoc = { ...parseHead(structure), components: parseSmallComponents(structure) };
    const endpoints = resolveOAuthEndpoints(headDoc, selection);

    const permissionsReference =
      selection.coversFullGraph === true
        ? yield* fetchMicrosoftGraphPermissionsReference().pipe(Effect.provide(httpClientLayer))
        : undefined;
    const fullGraphScopes = permissionsReference
      ? parseMicrosoftGraphDelegatedScopes(permissionsReference)
      : [];

    const keepPathItem = microsoftGraphKeepPathItem(selection);
    const scopes =
      selection.coversFullGraph === true && selection.customScopes.length === 0
        ? [...MICROSOFT_GRAPH_DELEGATED_DEFAULT_SCOPES]
        : streamSelectedScopes(
            structure,
            selection.coversFullGraph === true
              ? uniqueStrings([...MICROSOFT_GRAPH_BASE_SCOPES, ...selection.customScopes])
              : selection.scopes,
            fullGraphScopes,
            keepPathItem,
          );

    return {
      ...selection,
      specText: sourceText,
      scopes,
      authorizationUrl: endpoints.authorizationUrl,
      tokenUrl: endpoints.tokenUrl,
      clientCredentialsTokenUrl: endpoints.clientCredentialsTokenUrl,
      authenticationTemplate: microsoftOAuthTemplate(scopes, endpoints),
    };
  });
