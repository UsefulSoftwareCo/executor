// Converts Google Discovery documents directly into OpenAPI 3.x. Public
// Discovery converters currently target Swagger 2.0 or a broad conversion
// pipeline; this adapter emits the shape Executor parses while preserving
// Executor-specific tool ids and query semantics.
import { Effect, Option, Predicate, Schema, SchemaGetter } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { OpenApiParseError, type Authentication } from "@executor-js/plugin-openapi";
import { compactGoogleOAuthScopes } from "./oauth-scopes";
import { AuthTemplateSlug } from "@executor-js/sdk/shared";

interface SpecFetchCredentials {
  readonly headers?: Record<string, string>;
  readonly queryParams?: Record<string, string>;
}

const DISCOVERY_SERVICE_HOST = "https://www.googleapis.com/discovery/v1/apis";
const GOOGLE_BUNDLE_BASE_URL = "https://www.googleapis.com/";
const GOOGLE_OAUTH_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OPENAPI_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

type OpenApiSchemaObject = {
  readonly $ref?: string;
  readonly type?: "array" | "boolean" | "integer" | "null" | "number" | "object" | "string";
  readonly description?: string;
  readonly title?: string;
  readonly format?: string;
  readonly readOnly?: boolean;
  readonly default?: JsonValue;
  readonly enum?: readonly JsonValue[];
  readonly items?: OpenApiSchemaObject;
  readonly properties?: Record<string, OpenApiSchemaObject>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | OpenApiSchemaObject;
};

type OpenApiParameterObject = {
  readonly name: string;
  readonly in: "path" | "query" | "header";
  readonly required: boolean;
  readonly description?: string;
  readonly schema: OpenApiSchemaObject;
  readonly style?: "form";
  readonly explode?: boolean;
  readonly allowReserved?: boolean;
};

type OpenApiOperationObject = {
  readonly operationId: string;
  readonly "x-executor-toolPath": string;
  readonly "x-executor-pathTemplate"?: string;
  readonly tags?: readonly string[];
  readonly description?: string;
  readonly servers?: readonly { readonly url: string }[];
  readonly parameters: readonly OpenApiParameterObject[];
  readonly requestBody?: {
    readonly required: boolean;
    readonly content: Record<
      string,
      {
        readonly schema: OpenApiSchemaObject;
      }
    >;
  };
  readonly responses: {
    readonly "200": {
      readonly description: "Successful response";
      readonly content: Record<
        string,
        {
          readonly schema: OpenApiSchemaObject;
        }
      >;
    };
  };
  readonly security?: readonly Record<string, readonly string[]>[];
  readonly "x-google-scopes": readonly string[];
};

type OpenApiDocument = {
  readonly openapi: "3.1.0";
  readonly info: {
    readonly title: string;
    readonly version: string;
  };
  readonly servers: readonly { readonly url: string }[];
  readonly paths: Record<string, Record<string, OpenApiOperationObject>>;
  readonly components: {
    readonly schemas: Record<string, OpenApiSchemaObject>;
    readonly securitySchemes?: Record<
      string,
      {
        readonly type: "oauth2";
        readonly flows: {
          readonly authorizationCode: {
            readonly authorizationUrl: string;
            readonly tokenUrl: string;
            readonly scopes: Record<string, string>;
          };
        };
      }
    >;
  };
  readonly security?: readonly Record<string, readonly string[]>[];
  readonly "x-executor-origin":
    | {
        readonly kind: "googleDiscovery";
        readonly discoveryUrl: string;
        readonly service: string;
        readonly version: string;
      }
    | {
        readonly kind: "googleDiscoveryBundle";
        readonly services: readonly {
          readonly discoveryUrl: string;
          readonly service: string;
          readonly version: string;
        }[];
      };
};

const TextOption = Schema.OptionFromOptional(Schema.Trim).pipe(
  Schema.decode({
    decode: SchemaGetter.transform((value) => Option.filter(value, (text) => text.length > 0)),
    encode: SchemaGetter.transform((value) => value),
  }),
  Schema.withDecodingDefaultType(Effect.succeed(Option.none())),
);
const TextArray = Schema.optional(Schema.Array(Schema.String)).pipe(
  Schema.withDecodingDefaultType(Effect.succeed([] as string[])),
);
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const UnknownRecordWithDefault = Schema.optional(UnknownRecord).pipe(
  Schema.withDecodingDefaultType(Effect.succeed({})),
);

const DiscoveryParameter = Schema.Struct({
  type: Schema.optional(Schema.String),
  description: TextOption,
  properties: UnknownRecordWithDefault,
  items: Schema.optional(Schema.Unknown),
  additionalProperties: Schema.optional(Schema.Union([Schema.Boolean, Schema.Unknown])),
  enum: TextArray,
  format: Schema.optional(Schema.String),
  readOnly: Schema.optional(Schema.Boolean),
  default: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  $ref: Schema.optional(Schema.String),
  location: Schema.optional(Schema.Literals(["path", "query", "header"])),
  required: Schema.optional(Schema.Boolean),
  repeated: Schema.optional(Schema.Boolean),
});
type DiscoveryParameter = typeof DiscoveryParameter.Type;

const DiscoveryRef = Schema.Struct({
  $ref: Schema.optional(Schema.String),
});

const DiscoveryMethod = Schema.Struct({
  id: TextOption,
  description: TextOption,
  httpMethod: Schema.optional(Schema.String),
  path: TextOption,
  parameters: UnknownRecordWithDefault,
  request: Schema.optional(DiscoveryRef),
  response: Schema.optional(DiscoveryRef),
  scopes: TextArray,
  supportsMediaDownload: Schema.optional(Schema.Boolean),
  useMediaDownloadService: Schema.optional(Schema.Boolean),
});
type DiscoveryMethod = typeof DiscoveryMethod.Type;

const DiscoveryResource = Schema.Struct({
  methods: UnknownRecordWithDefault,
  resources: UnknownRecordWithDefault,
});

const DiscoveryDocument = Schema.Struct({
  name: TextOption,
  version: TextOption,
  title: TextOption,
  rootUrl: TextOption,
  servicePath: Schema.optional(Schema.Trim).pipe(
    Schema.withDecodingDefaultType(Effect.succeed("")),
  ),
  parameters: UnknownRecordWithDefault,
  methods: UnknownRecordWithDefault,
  resources: UnknownRecordWithDefault,
  schemas: UnknownRecordWithDefault,
  auth: Schema.optional(
    Schema.Struct({
      oauth2: Schema.optional(
        Schema.Struct({
          scopes: Schema.optional(
            Schema.Record(
              Schema.String,
              Schema.Struct({
                description: TextOption,
              }),
            ),
          ).pipe(Schema.withDecodingDefaultType(Effect.succeed({}))),
        }),
      ),
    }),
  ),
});
type DiscoveryDocument = typeof DiscoveryDocument.Type;

export interface GoogleDiscoveryOpenApiConversion {
  readonly specText: string;
  readonly baseUrl: string;
  readonly title: string;
  readonly service: string;
  readonly version: string;
  readonly discoveryUrls?: readonly string[];
  /** The v2 oauth auth template the converted integration declares, when the
   *  Discovery document advertises OAuth2 scopes. */
  readonly authenticationTemplate?: readonly Authentication[];
}

const decodeDiscoveryDocument = Schema.decodeUnknownSync(DiscoveryDocument);
const decodeDiscoveryParameter = Schema.decodeUnknownSync(DiscoveryParameter);
const decodeDiscoveryMethod = Schema.decodeUnknownSync(DiscoveryMethod);
const decodeDiscoveryResource = Schema.decodeUnknownSync(DiscoveryResource);
const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const DISCOVERY_SERVICE_PATH_RE =
  /^\/discovery\/v1\/apis\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/rest\/?$/;
const DISCOVERY_VERSION_RE = /^[A-Za-z0-9._-]+$/;

const serviceFromGoogleApisHost = (host: string): string | null => {
  if (!host.endsWith(".googleapis.com")) return null;
  const rawService = host.slice(0, -".googleapis.com".length);
  if (!rawService || rawService.includes(".")) return null;
  const service =
    rawService === "calendar-json"
      ? "calendar"
      : rawService.endsWith("-json")
        ? rawService.slice(0, -5)
        : rawService;
  return /^[a-z0-9][a-z0-9-]*$/.test(service) ? service : null;
};

export const normalizeGoogleDiscoveryUrl = (discoveryUrl: string): string | null => {
  const trimmed = discoveryUrl.trim();
  if (!URL.canParse(trimmed)) return null;
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "www.googleapis.com") {
    if (parsed.search) return null;
    const match = parsed.pathname.match(DISCOVERY_SERVICE_PATH_RE);
    const service = match?.[1];
    const version = match?.[2];
    return service && version ? `${DISCOVERY_SERVICE_HOST}/${service}/${version}/rest` : null;
  }

  const service = serviceFromGoogleApisHost(host);
  if (!service || !["/$discovery/rest", "/$discovery/rest/"].includes(parsed.pathname)) {
    return null;
  }
  const keys = [...parsed.searchParams.keys()];
  const version = parsed.searchParams.get("version")?.trim();
  if (
    keys.length !== 1 ||
    keys[0] !== "version" ||
    !version ||
    !DISCOVERY_VERSION_RE.test(version)
  ) {
    return null;
  }
  return `${DISCOVERY_SERVICE_HOST}/${service}/${version}/rest`;
};

const normalizeDiscoveryUrl = (discoveryUrl: string): string => {
  return normalizeGoogleDiscoveryUrl(discoveryUrl) ?? discoveryUrl.trim();
};

export const isGoogleDiscoveryUrl = (url: string): boolean => {
  return normalizeGoogleDiscoveryUrl(url) !== null;
};

export const fetchGoogleDiscoveryDocument = Effect.fn("OpenApi.fetchGoogleDiscoveryDocument")(
  function* (discoveryUrl: string, credentials?: SpecFetchCredentials) {
    const normalizedDiscoveryUrl = normalizeGoogleDiscoveryUrl(discoveryUrl);
    if (!normalizedDiscoveryUrl) {
      return yield* new OpenApiParseError({
        message:
          "Google Discovery document URL must be a supported googleapis.com HTTPS Discovery endpoint",
      });
    }
    const client = yield* HttpClient.HttpClient;
    const requestUrl = new URL(normalizedDiscoveryUrl);
    for (const [name, value] of Object.entries(credentials?.queryParams ?? {})) {
      requestUrl.searchParams.set(name, value);
    }
    let request = HttpClientRequest.get(requestUrl.toString()).pipe(
      HttpClientRequest.setHeader("Accept", "application/json, */*"),
    );
    for (const [name, value] of Object.entries(credentials?.headers ?? {})) {
      request = HttpClientRequest.setHeader(request, name, value);
    }
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        () =>
          new OpenApiParseError({
            message: "Failed to fetch Google Discovery document",
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new OpenApiParseError({
        message: `Failed to fetch Google Discovery document: HTTP ${response.status}`,
      });
    }
    return yield* response.text.pipe(
      Effect.mapError(
        () =>
          new OpenApiParseError({
            message: "Failed to read Google Discovery document body",
          }),
      ),
    );
  },
);

const schemaRef = (name: string) => `#/components/schemas/${name}`;

const identitySchemaName = (name: string): string => name;

const schemaComponentPart = (value: string): string =>
  value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "schema";

const normalizeDiscoveryPathTemplate = (pathTemplate: string): string =>
  pathTemplate.replaceAll(/\{\+([^{}]+)\}/g, "{$1}");

const pathUsesReservedExpansion = (pathTemplate: string, parameterName: string): boolean =>
  pathTemplate.includes(`{+${parameterName}}`);

const uniquePathKey = (
  paths: Record<string, Record<string, OpenApiOperationObject>>,
  preferredPath: string,
  method: string,
  toolPath: string,
): string => {
  if (!paths[preferredPath]?.[method]) return preferredPath;
  const disambiguated = `/${toolPath.replace(/[^A-Za-z0-9._~-]+/g, "/")}`;
  if (!paths[disambiguated]?.[method]) return disambiguated;
  let index = 2;
  while (paths[`${disambiguated}/${index}`]?.[method]) index += 1;
  return `${disambiguated}/${index}`;
};

const discoveryDescription = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : Option.isOption(value) && Option.isSome(value)
      ? typeof value.value === "string"
        ? value.value
        : undefined
      : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jsonValue = (value: unknown): JsonValue | undefined => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const values = value.map(jsonValue);
    return values.every(Predicate.isNotUndefined) ? values : undefined;
  }
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).flatMap(([key, item]) => {
    const converted = jsonValue(item);
    return converted === undefined ? [] : [[key, converted] as const];
  });
  return Object.fromEntries(entries);
};

const stringArray = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length ? strings : undefined;
};

const schemaType = (value: unknown): OpenApiSchemaObject["type"] | undefined =>
  typeof value === "string" && OPENAPI_SCHEMA_TYPES.has(value)
    ? (value as OpenApiSchemaObject["type"])
    : undefined;

const discoverySchemaToOpenApiSchema = (
  raw: unknown,
  schemaNameForRef: (name: string) => string = identitySchemaName,
): OpenApiSchemaObject => {
  if (!isRecord(raw)) return {};
  const schema = raw;
  if (typeof schema.$ref === "string") return { $ref: schemaRef(schemaNameForRef(schema.$ref)) };

  const description = discoveryDescription(schema.description);
  const title = discoveryDescription(schema.title);
  const defaultValue = jsonValue(schema.default);
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum.map(jsonValue).filter(Predicate.isNotUndefined)
    : [];
  const format = typeof schema.format === "string" ? schema.format : undefined;
  const readOnly = typeof schema.readOnly === "boolean" ? schema.readOnly : undefined;
  const type = schemaType(schema.type);

  const base = {
    ...(description !== undefined ? { description } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(readOnly !== undefined ? { readOnly } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(enumValues.length > 0 ? { enum: enumValues } : {}),
  } satisfies OpenApiSchemaObject;

  if (type === "array") {
    return {
      ...base,
      type: "array",
      items: discoverySchemaToOpenApiSchema(schema.items, schemaNameForRef),
    };
  }

  const properties = schema.properties;
  if (
    type === "object" ||
    (isRecord(properties) && Object.keys(properties).length > 0) ||
    schema.additionalProperties !== undefined
  ) {
    const convertedProperties = isRecord(properties)
      ? Object.fromEntries(
          Object.entries(properties).map(([name, value]) => [
            name,
            discoverySchemaToOpenApiSchema(value, schemaNameForRef),
          ]),
        )
      : undefined;
    const required = stringArray(schema.required);
    const additionalProperties =
      schema.additionalProperties === undefined
        ? undefined
        : typeof schema.additionalProperties === "boolean"
          ? schema.additionalProperties
          : discoverySchemaToOpenApiSchema(schema.additionalProperties, schemaNameForRef);
    return {
      ...base,
      type: "object",
      ...(convertedProperties && Object.keys(convertedProperties).length > 0
        ? { properties: convertedProperties }
        : {}),
      ...(required && required.length > 0 ? { required } : {}),
      ...(additionalProperties !== undefined ? { additionalProperties } : {}),
    };
  }

  return type !== undefined ? { ...base, type } : base;
};

const parameterSchema = (
  parameter: DiscoveryParameter,
  schemaNameForRef: (name: string) => string = identitySchemaName,
): OpenApiSchemaObject => {
  const base = discoverySchemaToOpenApiSchema(parameter, schemaNameForRef);
  return parameter.repeated
    ? {
        type: "array",
        items: base,
      }
    : base;
};

const methodToolPath = (service: string, methodId: string): string =>
  methodId.startsWith(`${service}.`) ? methodId.slice(service.length + 1) : methodId;

const collectMethods = (resource: unknown): DiscoveryMethod[] => {
  const decoded = decodeDiscoveryResource(resource);
  const direct = Object.values(decoded.methods ?? {}).map((raw) => decodeDiscoveryMethod(raw));
  const nested = Object.values(decoded.resources ?? {}).flatMap(collectMethods);
  return [...direct, ...nested];
};

const discoveryScopes = (document: DiscoveryDocument): Record<string, string> =>
  Object.fromEntries(
    Object.entries(document.auth?.oauth2?.scopes ?? {}).map(([scope, value]) => [
      scope,
      Option.getOrElse(value.description, () => ""),
    ]),
  );

// The scope set the converted integration DECLARES (and that `oauth.start`
// requests at connect) must match the consent the picker previews. Both run the
// raw Discovery union through `compactGoogleOAuthScopes`, which drops scopes a
// user OAuth consent screen can't show (`chat.bot`/`chat.app.*`/`keep`) and
// collapses sub-scopes under their broad parent (`gmail.*` → `mail.google.com`,
// `userinfo.email` → `email`). Descriptions are preserved where the raw map had
// them; compaction-introduced identity scopes (`email`/`profile`) fall back to
// the broad parent's description. Per-operation `x-google-scopes`/`security`
// stay RAW - they describe which scope each method needs, not consent.
const compactDiscoveryScopeMap = (raw: Record<string, string>): Record<string, string> => {
  const descriptionFor = (scope: string): string => {
    if (raw[scope] !== undefined) return raw[scope];
    if (scope === "email") return raw["https://www.googleapis.com/auth/userinfo.email"] ?? "";
    if (scope === "profile") return raw["https://www.googleapis.com/auth/userinfo.profile"] ?? "";
    return "";
  };
  return Object.fromEntries(
    compactGoogleOAuthScopes(Object.keys(raw)).map((scope) => [scope, descriptionFor(scope)]),
  );
};

const allDiscoveryMethods = (document: DiscoveryDocument): DiscoveryMethod[] => [
  ...Object.values(document.methods ?? {}).map((raw) => decodeDiscoveryMethod(raw)),
  ...Object.values(document.resources ?? {}).flatMap(collectMethods),
];

type DiscoveryDocumentInfo = {
  readonly discoveryUrl: string;
  readonly document: DiscoveryDocument;
  readonly service: string;
  readonly version: string;
  readonly rootUrl: string;
  readonly baseUrl: string;
  readonly title: string;
};

const discoveryDocumentInfo = (
  document: DiscoveryDocument,
  discoveryUrl: string,
): Effect.Effect<DiscoveryDocumentInfo, OpenApiParseError> =>
  Effect.gen(function* () {
    const service = Option.getOrUndefined(document.name);
    const version = Option.getOrUndefined(document.version);
    const rootUrl = Option.getOrUndefined(document.rootUrl);
    if (!service || !version || !rootUrl) {
      return yield* new OpenApiParseError({
        message: "Google Discovery document is missing one of: name, version, rootUrl",
      });
    }

    return {
      discoveryUrl,
      document,
      service,
      version,
      rootUrl,
      baseUrl: new URL(document.servicePath || "", rootUrl).toString(),
      title: Option.getOrElse(document.title, () => `${service} ${version}`),
    };
  });

const googleDiscoveryResponseContent = (
  method: DiscoveryMethod,
  schemaNameForRef: (name: string) => string,
): OpenApiOperationObject["responses"]["200"]["content"] => {
  if (
    (method.supportsMediaDownload === true || method.useMediaDownloadService === true) &&
    method.response === undefined
  ) {
    return {
      "application/octet-stream": {
        schema: {
          type: "string",
          format: "binary",
        },
      },
    };
  }

  return {
    "application/json": {
      schema: method.response?.$ref
        ? { $ref: schemaRef(schemaNameForRef(method.response.$ref)) }
        : {},
    },
  };
};

const buildDiscoveryOperation = (input: {
  readonly document: DiscoveryDocument;
  readonly method: DiscoveryMethod;
  readonly toolPath: string;
  readonly pathTemplate: string;
  readonly oauthScopes?: readonly string[];
  readonly schemaNameForRef?: (name: string) => string;
  readonly serverUrl?: string;
  readonly tags?: readonly string[];
}): OpenApiOperationObject => {
  const mergedParameters = new Map<string, DiscoveryParameter>();
  for (const [name, raw] of Object.entries(input.document.parameters ?? {})) {
    const parameter = decodeDiscoveryParameter(raw);
    if (parameter.location) mergedParameters.set(name, parameter);
  }
  for (const [name, raw] of Object.entries(input.method.parameters ?? {})) {
    const parameter = decodeDiscoveryParameter(raw);
    if (parameter.location) mergedParameters.set(name, parameter);
  }

  const methodScopes = input.oauthScopes ?? input.method.scopes ?? [];
  const methodDescription = Option.getOrUndefined(input.method.description);
  const schemaNameForRef = input.schemaNameForRef ?? identitySchemaName;

  return {
    operationId: input.toolPath,
    "x-executor-toolPath": input.toolPath,
    "x-executor-pathTemplate": input.pathTemplate,
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    ...(methodDescription !== undefined ? { description: methodDescription } : {}),
    ...(input.serverUrl ? { servers: [{ url: input.serverUrl }] } : {}),
    parameters: [...mergedParameters.entries()].flatMap(([name, parameter]) => {
      const location = parameter.location;
      if (!location) return [];
      const description = Option.getOrUndefined(parameter.description);
      const allowReserved =
        location === "path" && pathUsesReservedExpansion(input.pathTemplate, name);
      return [
        {
          name,
          in: location,
          required: location === "path" ? true : parameter.required === true,
          ...(description !== undefined ? { description } : {}),
          schema: parameterSchema(parameter, schemaNameForRef),
          ...(location === "query"
            ? { style: "form" as const, explode: parameter.repeated === true }
            : {}),
          ...(allowReserved ? { allowReserved: true } : {}),
        },
      ];
    }),
    ...(input.method.request?.$ref
      ? {
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: { $ref: schemaRef(schemaNameForRef(input.method.request.$ref)) },
              },
            },
          },
        }
      : {}),
    responses: {
      "200": {
        description: "Successful response",
        content: googleDiscoveryResponseContent(input.method, schemaNameForRef),
      },
    },
    ...(methodScopes.length > 0 ? { security: [{ googleOAuth2: methodScopes }] } : {}),
    "x-google-scopes": methodScopes,
  };
};

const GOOGLE_OAUTH_SECURITY_SCHEME = "googleOAuth2";
const GOOGLE_PHOTOS_LIBRARY_SERVICE = "photoslibrary";
const GOOGLE_PHOTOS_PICKER_SERVICE = "photospicker";
const GOOGLE_PHOTOS_APPENDONLY_SCOPE = "https://www.googleapis.com/auth/photoslibrary.appendonly";
const GOOGLE_PHOTOS_UPLOAD_TOOL_PATH = "photoslibrary.mediaItems.upload";
const GOOGLE_PHOTOS_UPLOAD_PATH = "/uploads";

const isGooglePhotosService = (service: string): boolean =>
  service === GOOGLE_PHOTOS_LIBRARY_SERVICE || service === GOOGLE_PHOTOS_PICKER_SERVICE;

/** The v2 oauth auth template for a Google-discovery integration. The spec
 *  itself carries the matching `securitySchemes.googleOAuth2` entry; this is the
 *  catalog-level template a connection's access token renders through. */
const googleOauthTemplate = (scopes: Record<string, string>): readonly Authentication[] =>
  // A Google-discovery integration is ALWAYS OAuth, so it ALWAYS declares its
  // oauth method - even when the compacted scope set is empty (e.g. a bundle of
  // only limited-consent APIs like Google Keep, whose scopes Google won't grant
  // through standard consent). Without this the integration declares no auth
  // method and the "Add account" / "Add a connection" actions are disabled, so
  // you can't even start the flow. Empty `scopes` just requests no scope.
  [
    {
      slug: AuthTemplateSlug.make(GOOGLE_OAUTH_SECURITY_SCHEME),
      kind: "oauth2",
      authorizationUrl: GOOGLE_OAUTH_AUTHORIZATION_URL,
      tokenUrl: GOOGLE_OAUTH_TOKEN_URL,
      scopes: Object.keys(scopes),
    },
  ];

const googlePhotosUploadOperation = (input: {
  readonly toolPath: string;
  readonly oauthScopes: readonly string[];
  readonly serverUrl: string;
  readonly tags?: readonly string[];
}): OpenApiOperationObject => ({
  operationId: input.toolPath,
  "x-executor-toolPath": input.toolPath,
  "x-executor-pathTemplate": GOOGLE_PHOTOS_UPLOAD_PATH,
  ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
  description:
    "Uploads raw photo or video bytes to Google Photos and returns a plain-text upload token. Call mediaItems.batchCreate with the returned token to create the media item.",
  servers: [{ url: input.serverUrl }],
  parameters: [
    {
      name: "X-Goog-Upload-File-Name",
      in: "header",
      required: true,
      description: "File name Google Photos should associate with the uploaded bytes.",
      schema: { type: "string" },
    },
    {
      name: "X-Goog-Upload-Protocol",
      in: "header",
      required: true,
      description: "Google Photos raw upload protocol. Set to raw.",
      schema: { type: "string", enum: ["raw"], default: "raw" },
    },
    {
      name: "X-Goog-Upload-Content-Type",
      in: "header",
      required: false,
      description: "MIME type of the uploaded media, for example image/jpeg or video/mp4.",
      schema: { type: "string" },
    },
  ],
  requestBody: {
    required: true,
    content: {
      "application/octet-stream": {
        schema: { type: "string", format: "binary" },
      },
    },
  },
  responses: {
    "200": {
      description: "Successful response",
      content: {
        "text/plain": {
          schema: { type: "string" },
        },
      },
    },
  },
  ...(input.oauthScopes.length > 0 ? { security: [{ googleOAuth2: input.oauthScopes }] } : {}),
  "x-google-scopes": input.oauthScopes,
});

const hasOperation = (
  paths: Record<string, Record<string, OpenApiOperationObject>>,
  operationId: string,
): boolean =>
  Object.values(paths).some((pathItem) =>
    Object.values(pathItem).some((operation) => operation.operationId === operationId),
  );

export const convertGoogleDiscoveryToOpenApi = Effect.fn("OpenApi.convertGoogleDiscovery")(
  function* (input: { readonly discoveryUrl: string; readonly documentText: string }) {
    const parsed = yield* parseJson(input.documentText).pipe(
      Effect.mapError(
        () =>
          new OpenApiParseError({
            message: "Failed to parse Google Discovery document",
          }),
      ),
    );
    const document = yield* Effect.try({
      try: () => decodeDiscoveryDocument(parsed),
      catch: () =>
        new OpenApiParseError({
          message: "Failed to decode Google Discovery document",
        }),
    });

    const info = yield* discoveryDocumentInfo(document, input.discoveryUrl);
    const { service, version, baseUrl, title } = info;
    const paths: Record<string, Record<string, OpenApiOperationObject>> = {};

    for (const method of allDiscoveryMethods(document)) {
      const methodId = Option.getOrUndefined(method.id);
      const pathTemplate = Option.getOrUndefined(method.path);
      if (!methodId || !pathTemplate || !method.httpMethod) continue;

      const toolPath = methodToolPath(service, methodId);
      const path = normalizeDiscoveryPathTemplate(
        pathTemplate.startsWith("/") ? pathTemplate : `/${pathTemplate}`,
      );
      const methodKey = method.httpMethod.toLowerCase();
      const pathKey = uniquePathKey(paths, path, methodKey, toolPath);

      paths[pathKey] ??= {};
      paths[pathKey]![methodKey] = buildDiscoveryOperation({
        document,
        method,
        toolPath,
        pathTemplate: pathTemplate.startsWith("/") ? pathTemplate : `/${pathTemplate}`,
      });
    }

    if (
      service === GOOGLE_PHOTOS_LIBRARY_SERVICE &&
      !hasOperation(paths, GOOGLE_PHOTOS_UPLOAD_TOOL_PATH)
    ) {
      paths[GOOGLE_PHOTOS_UPLOAD_PATH] ??= {};
      paths[GOOGLE_PHOTOS_UPLOAD_PATH]!.post = googlePhotosUploadOperation({
        toolPath: GOOGLE_PHOTOS_UPLOAD_TOOL_PATH,
        oauthScopes: [GOOGLE_PHOTOS_APPENDONLY_SCOPE],
        serverUrl: baseUrl,
      });
    }

    const scopes = compactDiscoveryScopeMap(discoveryScopes(document));
    const authenticationTemplate = googleOauthTemplate(scopes);

    const spec: OpenApiDocument = {
      openapi: "3.1.0",
      info: {
        title,
        version,
      },
      servers: [{ url: baseUrl }],
      paths,
      components: {
        schemas: Object.fromEntries(
          Object.entries(document.schemas ?? {}).map(([name, schema]) => [
            name,
            discoverySchemaToOpenApiSchema(schema),
          ]),
        ),
        ...(authenticationTemplate
          ? {
              securitySchemes: {
                googleOAuth2: {
                  type: "oauth2",
                  flows: {
                    authorizationCode: {
                      authorizationUrl: GOOGLE_OAUTH_AUTHORIZATION_URL,
                      tokenUrl: GOOGLE_OAUTH_TOKEN_URL,
                      scopes,
                    },
                  },
                },
              },
            }
          : {}),
      },
      ...(authenticationTemplate ? { security: [{ googleOAuth2: Object.keys(scopes) }] } : {}),
      "x-executor-origin": {
        kind: "googleDiscovery",
        discoveryUrl: normalizeDiscoveryUrl(input.discoveryUrl),
        service,
        version,
      },
    };

    return {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      specText: JSON.stringify(spec),
      baseUrl,
      title,
      service,
      version,
      ...(authenticationTemplate ? { authenticationTemplate } : {}),
    };
  },
);

export const convertGoogleDiscoveryBundleToOpenApi = Effect.fn(
  "OpenApi.convertGoogleDiscoveryBundle",
)(function* (input: {
  readonly documents: readonly { readonly discoveryUrl: string; readonly documentText: string }[];
  readonly consentScopes?: readonly string[];
}) {
  if (input.documents.length === 0) {
    return yield* new OpenApiParseError({
      message: "Google Discovery bundle requires at least one document",
    });
  }

  const infos = yield* Effect.forEach(input.documents, ({ discoveryUrl, documentText }) =>
    Effect.gen(function* () {
      const parsed = yield* parseJson(documentText).pipe(
        Effect.mapError(
          () =>
            new OpenApiParseError({
              message: "Failed to parse Google Discovery document",
            }),
        ),
      );
      const document = yield* Effect.try({
        try: () => decodeDiscoveryDocument(parsed),
        catch: () =>
          new OpenApiParseError({
            message: "Failed to decode Google Discovery document",
          }),
      });
      return yield* discoveryDocumentInfo(document, discoveryUrl);
    }),
  );

  const paths: Record<string, Record<string, OpenApiOperationObject>> = {};
  const schemas: Record<string, OpenApiSchemaObject> = {};
  const rawScopes: Record<string, string> = {};
  const consentScopeSet = input.consentScopes ? new Set(input.consentScopes) : null;

  for (const info of infos) {
    const schemaPrefix = schemaComponentPart(`${info.service}_${info.version}`);
    const schemaNameForRef = (name: string) => `${schemaPrefix}_${schemaComponentPart(name)}`;
    const scopeDescriptions = discoveryScopes(info.document);
    const filterPhotosScopes = consentScopeSet !== null && isGooglePhotosService(info.service);

    for (const [scope, description] of Object.entries(scopeDescriptions)) {
      if (filterPhotosScopes && !consentScopeSet.has(scope)) continue;
      rawScopes[scope] ??= description;
    }

    for (const [name, schema] of Object.entries(info.document.schemas ?? {})) {
      schemas[schemaNameForRef(name)] = discoverySchemaToOpenApiSchema(schema, schemaNameForRef);
    }

    for (const method of allDiscoveryMethods(info.document)) {
      const methodId = Option.getOrUndefined(method.id);
      const rawPathTemplate = Option.getOrUndefined(method.path);
      if (!methodId || !rawPathTemplate || !method.httpMethod) continue;
      const methodScopes = method.scopes ?? [];
      const oauthScopes = filterPhotosScopes
        ? methodScopes.filter((scope) => consentScopeSet.has(scope))
        : methodScopes;
      if (filterPhotosScopes && methodScopes.length > 0 && oauthScopes.length === 0) continue;

      const toolPath = methodId;
      const wirePath = rawPathTemplate.startsWith("/") ? rawPathTemplate : `/${rawPathTemplate}`;
      const openApiPath = normalizeDiscoveryPathTemplate(wirePath);
      const methodKey = method.httpMethod.toLowerCase();
      const pathKey = uniquePathKey(paths, openApiPath, methodKey, toolPath);

      paths[pathKey] ??= {};
      paths[pathKey]![methodKey] = buildDiscoveryOperation({
        document: info.document,
        method,
        toolPath,
        pathTemplate: wirePath,
        oauthScopes,
        schemaNameForRef,
        serverUrl: info.baseUrl,
        tags: [info.title],
      });
    }

    if (
      info.service === GOOGLE_PHOTOS_LIBRARY_SERVICE &&
      (!consentScopeSet || consentScopeSet.has(GOOGLE_PHOTOS_APPENDONLY_SCOPE)) &&
      !hasOperation(paths, GOOGLE_PHOTOS_UPLOAD_TOOL_PATH)
    ) {
      paths[GOOGLE_PHOTOS_UPLOAD_PATH] ??= {};
      paths[GOOGLE_PHOTOS_UPLOAD_PATH]!.post = googlePhotosUploadOperation({
        toolPath: GOOGLE_PHOTOS_UPLOAD_TOOL_PATH,
        oauthScopes: [GOOGLE_PHOTOS_APPENDONLY_SCOPE],
        serverUrl: info.baseUrl,
        tags: [info.title],
      });
    }
  }

  const scopes = compactDiscoveryScopeMap(rawScopes);
  const authenticationTemplate = googleOauthTemplate(scopes);
  const spec: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: "Google",
      version: "google-discovery-bundle",
    },
    servers: [{ url: GOOGLE_BUNDLE_BASE_URL }],
    paths,
    components: {
      schemas,
      ...(authenticationTemplate
        ? {
            securitySchemes: {
              googleOAuth2: {
                type: "oauth2",
                flows: {
                  authorizationCode: {
                    authorizationUrl: GOOGLE_OAUTH_AUTHORIZATION_URL,
                    tokenUrl: GOOGLE_OAUTH_TOKEN_URL,
                    scopes,
                  },
                },
              },
            },
          }
        : {}),
    },
    ...(authenticationTemplate ? { security: [{ googleOAuth2: Object.keys(scopes) }] } : {}),
    "x-executor-origin": {
      kind: "googleDiscoveryBundle",
      services: infos.map((info) => ({
        discoveryUrl: normalizeDiscoveryUrl(info.discoveryUrl),
        service: info.service,
        version: info.version,
      })),
    },
  };

  return {
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    specText: JSON.stringify(spec),
    baseUrl: GOOGLE_BUNDLE_BASE_URL,
    title: "Google",
    service: "google",
    version: "google-discovery-bundle",
    discoveryUrls: infos.map((info) => normalizeDiscoveryUrl(info.discoveryUrl)),
    ...(authenticationTemplate ? { authenticationTemplate } : {}),
  };
});
