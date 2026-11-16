import { Effect, Option, Schema } from "effect";
import type { Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { AuthTemplateSlug } from "@executor-js/sdk/core";
import { AuthenticationSchema, type OpenApiIntegrationConfig } from "../../sdk/config";
import { OpenApiParseError } from "../../sdk/errors";
import {
  parseEntry,
  parseHead,
  parseSmallComponents,
  structuralSplit,
  type KeepPathItem,
  type SpecStructure,
} from "../../sdk/split";
import type { Authentication } from "../../sdk/types";

import {
  fetchMicrosoftGraphSlice,
  microsoftGraphPresetIdsForSliceAsset,
  microsoftGraphSliceAssetFromUrl,
} from "./slices";
import {
  MICROSOFT_AUTHORIZATION_URL,
  MICROSOFT_AUTH_TEMPLATE_SLUG,
  MICROSOFT_CLIENT_CREDENTIALS_AUTH_LABEL,
  MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG,
  MICROSOFT_DELEGATED_AUTH_LABEL,
  MICROSOFT_GRAPH_BASE_SCOPES,
  MICROSOFT_GRAPH_CLIENT_CREDENTIALS_SCOPES,
  MICROSOFT_GRAPH_DELEGATED_DEFAULT_SCOPES,
  MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  MICROSOFT_GRAPH_IDENTITY_SCOPE,
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

export interface MicrosoftGraphUrlPolicy {
  /**
   * When true, spec/base/OAuth endpoint URLs may point anywhere a trusted
   * https URL could, plus plain http on loopback (local Graph emulators).
   * Every other host is still rejected. Off by default — production leaves
   * this unset so only the pinned Microsoft Graph URLs are accepted.
   */
  readonly allowUnsafeUrlOverrides?: boolean;
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
  specUrl: Schema.optional(Schema.String),
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
    label: MICROSOFT_DELEGATED_AUTH_LABEL,
    authorizationUrl: endpoints.authorizationUrl,
    tokenUrl: endpoints.tokenUrl,
    scopes,
  },
  {
    slug: AuthTemplateSlug.make(MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG),
    kind: "oauth2",
    label: MICROSOFT_CLIENT_CREDENTIALS_AUTH_LABEL,
    authorizationUrl: endpoints.authorizationUrl,
    tokenUrl: endpoints.clientCredentialsTokenUrl,
    scopes: [...MICROSOFT_GRAPH_CLIENT_CREDENTIALS_SCOPES],
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const HTTP_METHODS = new Set(["delete", "get", "patch", "post", "put"]);
const REQUEST_BASE_SCOPES = new Set(["offline_access", "openid", "profile", "email"]);
const PATH_SCOPE_IGNORED_SCOPES = new Set([
  "offline_access",
  "openid",
  "profile",
  "email",
  MICROSOFT_GRAPH_IDENTITY_SCOPE,
]);

const firstString = (values: readonly unknown[]): string | undefined =>
  values.find((value): value is string => typeof value === "string" && value.trim().length > 0);

const parseTrustedHttpsUrl = (value: string): URL | null => {
  if (!URL.canParse(value)) return null;
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    return null;
  }
  return parsed;
};

// Local emulators (microsoft-emulator.test.ts, `microsoft.emulators.dev` run
// locally) serve plain http on loopback. Only these three hostnames count —
// this is not a general SSRF-safe "is this private" check, just a narrow
// allowance for the dev machine talking to itself.
const isLoopbackHostname = (hostname: string): boolean => {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower === "127.0.0.1" || lower === "::1" || lower === "[::1]";
};

const parseTrustedLoopbackHttpUrl = (value: string): URL | null => {
  if (!URL.canParse(value)) return null;
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.hash) {
    return null;
  }
  return isLoopbackHostname(parsed.hostname) ? parsed : null;
};

/**
 * Under `allowUnsafeUrlOverrides`, accept either a trusted https URL or a
 * plain-http URL on loopback (local emulators have no TLS). Every other URL
 * shape is still rejected, override or not.
 */
const allowUnsafeUrl = (
  value: string | undefined,
  policy: MicrosoftGraphUrlPolicy | undefined,
): string | undefined | null => {
  if (!value) return undefined;
  if (policy?.allowUnsafeUrlOverrides !== true) return null;
  return parseTrustedHttpsUrl(value) || parseTrustedLoopbackHttpUrl(value) ? value : null;
};

const normalizeMicrosoftGraphSpecUrl = (
  value: string,
  policy?: MicrosoftGraphUrlPolicy,
): string | null => {
  if (value === MICROSOFT_GRAPH_OPENAPI_URL) return value;
  const sliceAsset = microsoftGraphSliceAssetFromUrl(value);
  if (sliceAsset !== null && microsoftGraphPresetIdsForSliceAsset(sliceAsset) !== null) {
    return value;
  }
  return allowUnsafeUrl(value, policy) ?? null;
};

const MICROSOFT_GRAPH_HOSTS = new Set([
  "graph.microsoft.com",
  "graph.microsoft.us",
  "dod-graph.microsoft.us",
  "microsoftgraph.chinacloudapi.cn",
]);

const normalizeMicrosoftGraphBaseUrl = (
  value: string | undefined,
  policy?: MicrosoftGraphUrlPolicy,
): string | undefined | null => {
  const unsafe = allowUnsafeUrl(value, policy);
  if (unsafe !== null) return unsafe;
  if (!value) return undefined;
  const parsed = parseTrustedHttpsUrl(value);
  if (!parsed || !MICROSOFT_GRAPH_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  if (!/^\/(?:v1\.0|beta)(?:\/)?$/.test(parsed.pathname)) return null;
  if (parsed.search) return null;
  return parsed.toString().replace(/\/$/, "");
};

const MICROSOFT_IDENTITY_HOSTS = new Set([
  "login.microsoftonline.com",
  "login.microsoftonline.us",
  "login.partner.microsoftonline.cn",
]);

const normalizeMicrosoftOAuthEndpointUrl = (
  value: string,
  endpoint: "authorize" | "token",
  policy?: MicrosoftGraphUrlPolicy,
): string | null => {
  const unsafe = allowUnsafeUrl(value, policy);
  if (unsafe !== null) return unsafe ?? null;
  const parsed = parseTrustedHttpsUrl(value);
  if (!parsed || !MICROSOFT_IDENTITY_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  if (parsed.search) return null;
  const suffix = endpoint === "authorize" ? "authorize" : "token";
  return /^\/[^/]+\/oauth2\/v2\.0\/(?:authorize|token)$/.test(parsed.pathname) &&
    parsed.pathname.endsWith(`/${suffix}`)
    ? parsed.toString()
    : null;
};

const validateSelectionUrls = (
  selection: ReturnType<typeof normalizeSelection>,
  policy?: MicrosoftGraphUrlPolicy,
): Effect.Effect<ReturnType<typeof normalizeSelection>, OpenApiParseError> =>
  Effect.gen(function* () {
    const specUrl = normalizeMicrosoftGraphSpecUrl(selection.specUrl, policy);
    if (!specUrl) {
      return yield* new OpenApiParseError({
        message: "Microsoft Graph specUrl must point to the trusted Microsoft Graph OpenAPI spec",
      });
    }
    const baseUrl = normalizeMicrosoftGraphBaseUrl(selection.baseUrl, policy);
    if (baseUrl === null) {
      return yield* new OpenApiParseError({
        message: "Microsoft Graph baseUrl must point to a supported Microsoft Graph endpoint",
      });
    }
    const authorizationUrl = selection.authorizationUrl
      ? normalizeMicrosoftOAuthEndpointUrl(selection.authorizationUrl, "authorize", policy)
      : undefined;
    if (selection.authorizationUrl && !authorizationUrl) {
      return yield* new OpenApiParseError({
        message: "Microsoft authorizationUrl must point to a supported Microsoft identity endpoint",
      });
    }
    const tokenUrl = selection.tokenUrl
      ? normalizeMicrosoftOAuthEndpointUrl(selection.tokenUrl, "token", policy)
      : undefined;
    if (selection.tokenUrl && !tokenUrl) {
      return yield* new OpenApiParseError({
        message: "Microsoft tokenUrl must point to a supported Microsoft identity endpoint",
      });
    }
    const clientCredentialsTokenUrl = selection.clientCredentialsTokenUrl
      ? normalizeMicrosoftOAuthEndpointUrl(selection.clientCredentialsTokenUrl, "token", policy)
      : undefined;
    if (selection.clientCredentialsTokenUrl && !clientCredentialsTokenUrl) {
      return yield* new OpenApiParseError({
        message:
          "Microsoft clientCredentialsTokenUrl must point to a supported Microsoft identity endpoint",
      });
    }
    return {
      ...selection,
      specUrl,
      ...(baseUrl ? { baseUrl } : { baseUrl: undefined }),
      ...(authorizationUrl ? { authorizationUrl } : { authorizationUrl: undefined }),
      ...(tokenUrl ? { tokenUrl } : { tokenUrl: undefined }),
      ...(clientCredentialsTokenUrl
        ? { clientCredentialsTokenUrl }
        : { clientCredentialsTokenUrl: undefined }),
    };
  });

const validateResolvedOAuthEndpoints = (
  endpoints: MicrosoftOAuthEndpoints,
  policy?: MicrosoftGraphUrlPolicy,
): Effect.Effect<MicrosoftOAuthEndpoints, OpenApiParseError> =>
  Effect.gen(function* () {
    const authorizationUrl = normalizeMicrosoftOAuthEndpointUrl(
      endpoints.authorizationUrl,
      "authorize",
      policy,
    );
    const tokenUrl = normalizeMicrosoftOAuthEndpointUrl(endpoints.tokenUrl, "token", policy);
    const clientCredentialsTokenUrl = normalizeMicrosoftOAuthEndpointUrl(
      endpoints.clientCredentialsTokenUrl,
      "token",
      policy,
    );
    if (!authorizationUrl || !tokenUrl || !clientCredentialsTokenUrl) {
      return yield* new OpenApiParseError({
        message: "Microsoft OAuth endpoints must point to supported Microsoft identity endpoints",
      });
    }
    return { authorizationUrl, tokenUrl, clientCredentialsTokenUrl };
  });

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

const isIdentityHealthPath = (path: string): boolean =>
  graphPathMatchVariants(path).some((variant) => variant === "/me");

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
    (scope) => selectedScopes.has(scope) && !PATH_SCOPE_IGNORED_SCOPES.has(scope),
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
  // Always keep bare /me: the default identity health check depends on GET /me
  // even when the profile workload is unchecked.
  const pathMatchesSelection = matchesGraphPath(path, options.exactPaths, options.pathPrefixes);
  const identityHealthGetOnly = !pathMatchesSelection && isIdentityHealthPath(path);
  const kept: Record<string, unknown> = {};
  let hasOperation = false;

  for (const [key, value] of Object.entries(pathItem)) {
    const lowerKey = key.toLowerCase();
    if (!HTTP_METHODS.has(lowerKey)) continue;
    if (!isRecord(value)) continue;
    if (identityHealthGetOnly && lowerKey !== "get") continue;
    if (
      pathMatchesSelection ||
      identityHealthGetOnly ||
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

const normalizedMediaType = (mediaType: string): string =>
  mediaType.split(";")[0]?.trim().toLowerCase() ?? "";

const isBinaryStringSchema = (schema: unknown): boolean =>
  isRecord(schema) &&
  (schema.type === "string" || (Array.isArray(schema.type) && schema.type.includes("string"))) &&
  (schema.format === "binary" || schema.format === "byte");

// Graph declares success responses with the OpenAPI wildcard status key "2XX",
// never numeric codes like "200" (only "204" appears numerically in the spec).
const isSuccessStatusKey = (status: string): boolean =>
  /^2\d\d$/.test(status) || /^2xx$/i.test(status);

// Rewrite any success response whose `application/octet-stream` media carries a
// non-binary schema (report-style Graph endpoints declare `type: object` with a
// `value` property there) to a plain binary string, so the OpenAPI extractor
// emits a `binaryResponse` file hint. Already-binary media and all other media
// types and response fields are left untouched.
const normalizeMicrosoftGraphContentPathItem = (
  pathItem: Record<string, unknown>,
): Record<string, unknown> => {
  let changed = false;
  const next: Record<string, unknown> = { ...pathItem };

  for (const [key, operation] of Object.entries(pathItem)) {
    if (!HTTP_METHODS.has(key.toLowerCase()) || !isRecord(operation)) continue;
    const responses = isRecord(operation.responses) ? operation.responses : undefined;
    if (!responses) continue;

    let responsesChanged = false;
    const nextResponses: Record<string, unknown> = { ...responses };
    for (const [status, response] of Object.entries(responses)) {
      if (!isSuccessStatusKey(status) || !isRecord(response)) continue;
      const content = isRecord(response.content) ? response.content : undefined;
      if (!content) continue;

      let contentChanged = false;
      const nextContent: Record<string, unknown> = { ...content };
      for (const [mediaType, media] of Object.entries(content)) {
        if (normalizedMediaType(mediaType) !== "application/octet-stream") continue;
        const schema = isRecord(media) ? media.schema : undefined;
        if (isBinaryStringSchema(schema)) continue;
        nextContent[mediaType] = {
          ...(isRecord(media) ? media : {}),
          schema: { type: "string", format: "binary" },
        };
        contentChanged = true;
      }

      if (contentChanged) {
        nextResponses[status] = { ...response, content: nextContent };
        responsesChanged = true;
      }
    }

    if (responsesChanged) {
      next[key] = { ...operation, responses: nextResponses };
      changed = true;
    }
  }

  return changed ? next : pathItem;
};

// OneNote page writes. Graph's generated OpenAPI document models these from
// the OData entity model, which does not match the documented REST contract:
// - `POST .../pages` declares a JSON `onenotePage` body, but Graph accepts only
//   raw `text/html` or `multipart/form-data` with a `Presentation` part
//   (https://learn.microsoft.com/graph/api/section-post-pages) and rejects JSON
//   with HTTP 415.
// - `.../pages/{id}/content` lacks the documented `PATCH` update (a JSON array
//   of patch commands, `204 No Content`;
//   https://learn.microsoft.com/graph/api/page-update). It declares an
//   octet-stream `PUT` instead, which the update docs do not describe.
// The patterns cover `/me`, `/users/{id}`, `/groups/{id}`, and `/sites/{id}`,
// plus every nested section form Graph generates.
const GRAPH_ID_SEGMENT = String.raw`\{[^/}]+\}`;
const ONENOTE_ROOT = String.raw`^(?:/(?:v1\.0|beta))?/(?:me|(?:users|groups|sites)/${GRAPH_ID_SEGMENT})/onenote/`;
const ONENOTE_SECTION = String.raw`(?:(?:notebooks/${GRAPH_ID_SEGMENT}/)?(?:sectionGroups/${GRAPH_ID_SEGMENT}/)?sections/${GRAPH_ID_SEGMENT}/)?`;
const ONENOTE_PAGES_PATH = new RegExp(`${ONENOTE_ROOT}${ONENOTE_SECTION}pages$`);
const ONENOTE_PAGE_CONTENT_PATH = new RegExp(
  `${ONENOTE_ROOT}${ONENOTE_SECTION}pages/${GRAPH_ID_SEGMENT}/content$`,
);

const ONENOTE_HTML_DESCRIPTION =
  "Page content as a well-formed XHTML document. The title element sets the page title.";

const oneNoteCreatePageRequestBody = (): Record<string, unknown> => ({
  description:
    "Send the page HTML as a raw text/html body (default). Use multipart/form-data to " +
    "include images or files: the required Presentation part holds the page HTML, and " +
    "each other part is a file (pass a ToolFile value under the part name) that the HTML " +
    "references as name:<part-name>.",
  required: true,
  content: {
    "text/html": {
      schema: { type: "string", description: ONENOTE_HTML_DESCRIPTION },
    },
    "multipart/form-data": {
      schema: {
        type: "object",
        required: ["Presentation"],
        properties: {
          Presentation: { type: "string", description: ONENOTE_HTML_DESCRIPTION },
        },
        additionalProperties: { type: "string", format: "binary" },
      },
      encoding: { Presentation: { contentType: "text/html" } },
    },
  },
});

const oneNotePatchPageContentOperation = (
  template: Record<string, unknown>,
  writeTemplate: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  // Permissions come from the generated write operation (the PUT), never from
  // the read operation the operationId is derived from.
  const writePermissions = writeTemplate
    ? Object.fromEntries(
        ["security", "x-ms-permissions"].flatMap((key) =>
          writeTemplate[key] !== undefined ? [[key, writeTemplate[key]]] : [],
        ),
      )
    : {};
  // `me.onenote.GetPagesContent` -> `me.onenote.PatchPagesContent`: unique per
  // path, and distinct from the generated PUT's `...UpdatePagesContent`.
  const templateOperationId =
    typeof template.operationId === "string" ? template.operationId : undefined;
  const derivedOperationId = templateOperationId?.replace(
    /\.(?:Get|Update)PagesContent$/,
    ".PatchPagesContent",
  );
  // Never reuse the template's id: an unrecognized shape gets no operationId
  // and the extractor names the tool from method and path instead.
  const operationId = derivedOperationId !== templateOperationId ? derivedOperationId : undefined;
  return {
    ...(Array.isArray(template.tags) ? { tags: template.tags } : {}),
    summary: "Update page",
    description:
      "Update the content of a OneNote page with an array of patch commands. Each command " +
      "targets an element (#<data-id>, a generated id, body, or title) and appends, inserts, " +
      "prepends, or replaces HTML content.",
    externalDocs: {
      description: "Find more info here",
      url: "https://learn.microsoft.com/graph/api/page-update?view=graph-rest-1.0",
    },
    ...(operationId ? { operationId } : {}),
    ...writePermissions,
    requestBody: {
      description: "Patch commands to apply to the page, in order.",
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "array",
            items: {
              type: "object",
              required: ["target", "action"],
              properties: {
                target: {
                  type: "string",
                  description:
                    "The element to update: #<data-id>, the generated id of the element, or the body or title keyword.",
                },
                // Inline lowercase enums: the documented wire values. The
                // generated component enums are PascalCase.
                action: {
                  type: "string",
                  enum: ["append", "insert", "prepend", "replace", "delete"],
                  description: "The action to perform on the target element.",
                },
                position: {
                  type: "string",
                  enum: ["after", "before"],
                  description:
                    "Where to add the content relative to the target element. Default: after.",
                },
                content: {
                  type: "string",
                  description: "Well-formed HTML to add to the page.",
                },
              },
            },
          },
        },
      },
    },
    responses: {
      "204": { description: "No Content" },
      "4XX": { $ref: "#/components/responses/error" },
      "5XX": { $ref: "#/components/responses/error" },
    },
    "x-ms-docs-operation-type": "operation",
  };
};

const normalizeMicrosoftGraphOneNotePathItem = (
  path: string,
  pathItem: Record<string, unknown>,
): Record<string, unknown> => {
  if (ONENOTE_PAGES_PATH.test(path)) {
    const post = pathItem.post;
    if (!isRecord(post)) return pathItem;
    return { ...pathItem, post: { ...post, requestBody: oneNoteCreatePageRequestBody() } };
  }

  if (ONENOTE_PAGE_CONTENT_PATH.test(path)) {
    const next: Record<string, unknown> = { ...pathItem };
    const template = isRecord(pathItem.get)
      ? pathItem.get
      : isRecord(pathItem.put)
        ? pathItem.put
        : undefined;
    // Always apply the documented PATCH contract, even over a PATCH the source
    // declares (it could carry a generated OData shape). A declared PATCH keeps
    // its operationId, so its tool name stays stable; this also keeps a second
    // pass over a corrected path item identical.
    const existingPatch = isRecord(pathItem.patch) ? pathItem.patch : undefined;
    const operationTemplate = template ?? existingPatch;
    if (operationTemplate) {
      const corrected = oneNotePatchPageContentOperation(
        operationTemplate,
        isRecord(pathItem.put) ? pathItem.put : existingPatch,
      );
      next.patch =
        typeof existingPatch?.operationId === "string"
          ? { ...corrected, operationId: existingPatch.operationId }
          : corrected;
    }
    // Keep the generated octet-stream PUT for existing callers, but mark it
    // deprecated and drop its link to the PATCH-only update docs so tool
    // selection prefers the documented update.
    if (isRecord(pathItem.put)) {
      const { externalDocs: _externalDocs, ...put } = pathItem.put;
      next.put = {
        ...put,
        summary: "Replace page content (undocumented)",
        description:
          "Generated media upload that the OneNote update docs do not describe. Use the PATCH operation on this path to update a page.",
        deprecated: true,
      };
    }
    return next;
  }

  return pathItem;
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
 * path-item as it parses the 37MB source. Full-graph selections keep every
 * path-item, but still pass through this transform so octet-stream success
 * responses are normalized to binary before the OpenAPI extractor runs. The
 * selection predicate is identical to the old two-pass filter: the selected
 * scopes are derived from the PRESET scopes (`microsoftGraphScopesForPresetIds`),
 * not the expanded OAuth scopes, so the kept operation set matches regardless
 * of caller.
 */
export const microsoftGraphKeepPathItem = (selection: {
  readonly coversFullGraph: boolean;
  readonly presetIds: readonly string[];
  readonly customScopes: readonly string[];
  readonly exactPaths: readonly string[];
  readonly pathPrefixes: readonly string[];
  readonly tagPrefixes: readonly string[];
}): KeepPathItem => {
  const exactPaths = new Set(selection.exactPaths);
  const selectedScopes = new Set(
    microsoftGraphScopesForPresetIds(selection.presetIds, selection.customScopes),
  );
  return (path, pathItem) => {
    const kept = selection.coversFullGraph
      ? pathItem
      : filterPathItem(path, pathItem, {
          exactPaths,
          pathPrefixes: selection.pathPrefixes,
          tagPrefixes: selection.tagPrefixes,
          selectedScopes,
        });
    return kept
      ? normalizeMicrosoftGraphOneNotePathItem(path, normalizeMicrosoftGraphContentPathItem(kept))
      : null;
  };
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
    ...requestedScopes.filter((scope) => !REQUEST_BASE_SCOPES.has(scope)),
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
  urlPolicy?: MicrosoftGraphUrlPolicy,
): Effect.Effect<MicrosoftGraphSpecBuild, OpenApiParseError> =>
  Effect.gen(function* () {
    // A slice URL carries its own selection: when the caller passes no preset
    // ids, the asset's selection applies (rather than the default bundle).
    const inputSliceAsset = input.specUrl
      ? microsoftGraphSliceAssetFromUrl(input.specUrl.trim())
      : null;
    const inputSlicePresetIds =
      inputSliceAsset !== null ? microsoftGraphPresetIdsForSliceAsset(inputSliceAsset) : null;
    const selectionInput =
      inputSlicePresetIds !== null && (!input.presetIds || input.presetIds.length === 0)
        ? { ...input, presetIds: inputSlicePresetIds }
        : input;
    const selection = yield* validateSelectionUrls(normalizeSelection(selectionInput), urlPolicy);
    // The URL is the byte source, never substituted. Catalog selections point
    // at precomputed slice URLs (the 43MB monolith cannot be processed in a
    // 128MB isolate — its fetch completed once in the 30 days before
    // 2026-08-26); the monolith and emulator-override URLs fetch exactly what
    // they name.
    const sourceText =
      microsoftGraphSliceAssetFromUrl(selection.specUrl) !== null
        ? yield* fetchMicrosoftGraphSlice(selection.specUrl).pipe(Effect.provide(httpClientLayer))
        : yield* fetchMicrosoftGraphOpenApiSpec(selection.specUrl).pipe(
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
    const endpoints = yield* validateResolvedOAuthEndpoints(
      resolveOAuthEndpoints(headDoc, selection),
      urlPolicy,
    );

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
